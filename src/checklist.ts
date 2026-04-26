/**
 * Generate the on-video outro checklist by asking Claude to enumerate
 * the SPECIFIC checks the agent performed during the run, alongside a
 * pass/fail/skip status and a one-line reason. The trivial "1 row per
 * goal" mapping was too abstract — a 1-3 line list doesn't tell the
 * reviewer what was actually exercised. Claude reads the agent's full
 * action history (clicks, types, snapshots, what they found) plus the
 * goal-level outcomes and synthesises 6-12 scannable rows.
 *
 * No fallback — if Claude fails the editor falls back to the simple
 * goal-level checklist via the caller. We don't throw.
 */
import chalk from "chalk";
import type { RunArtifacts } from "./types.js";
import { NARRATION_TIMEOUT_MS, CHECKLIST_MIN_ITEMS, CHECKLIST_MAX_ITEMS } from "./timeouts.js";
import { runClaude, extractJson } from "./claude-cli.js";

export interface ChecklistItem {
  outcome: "success" | "failure" | "skipped";
  label: string;
  note?: string;
}

const PROMPT = `You are summarising what an automated QA agent actually checked while reviewing a pull request. The output is a CHECKLIST shown on the final frame of a short review video — a reviewer pauses on it and reads to learn what was tested, what worked, and what failed.

OUTPUT FORMAT — STRICT JSON, no markdown, no prose:
{
  "items": [
    { "outcome": "success" | "failure" | "skipped", "label": string, "note"?: string },
    ... 6 to 12 entries
  ]
}

RULES:
- {{MIN_ITEMS}} to {{MAX_ITEMS}} items. Aim for the middle of that range — enough to feel substantive, few enough to scan in 5 seconds AND fit on a vertical 9:16 frame without scrolling.
- Each "label" is a specific CHECK that was performed: subject + verb form, ≤32 chars. Examples: "Today filter shows today task", "Overdue badge appears day 1", "Footer overdue count updates". NOT goal-level summaries.
- Status comes from the agent's actions: if the agent SAW the expected outcome → success; if the agent emitted failure for a goal that included this check → failure; if the agent never reached this check → skipped.
- "note": ONLY for failures (or skipped if the reason matters). 5-12 words explaining WHAT broke vs WHAT was expected. No prose, no apologies, no "the test". Good fail note: "filter empty despite TODAY badge". Good skip note: "blocked by earlier failure".
- Order: failures first (so truncation never hides them), then successes, then skipped.
- Don't invent checks the agent didn't actually do. Read the action log carefully — every label must map to specific clicks/types/snapshots.
- Don't repeat the same check phrased differently. Merge near-duplicates.
- Don't include trivia (login succeeded, page loaded). Focus on what the PR actually tests.

CONTEXT:
PR title: {{PR_TITLE}}
PR body (why this change matters):
{{PR_BODY}}

Plan goals (one per goal the agent ran):
{{GOALS}}

Agent action history (chronological — input is selector or value, result is what the agent saw / received):
{{ACTIONS}}

Return only the JSON.`;

export interface ChecklistContext {
  artifacts: RunArtifacts;
  prTitle?: string;
  prBody?: string;
}

function formatGoals(ctx: ChecklistContext): string {
  const events = ctx.artifacts.events.filter((e) => e.kind === "intent");
  if (events.length === 0) return "(no goals)";
  return events.map((e, i) => {
    const lines = [
      `${i + 1}. [${e.outcome.toUpperCase()}] ${e.description.replace(/\s+/g, " ").slice(0, 220)}`,
    ];
    if (e.notes) lines.push(`   AGENT NOTE: ${e.notes.replace(/\s+/g, " ").slice(0, 200)}`);
    return lines.join("\n");
  }).join("\n");
}

function formatActions(ctx: ChecklistContext): string {
  const tw = ctx.artifacts.toolWindows ?? [];
  if (tw.length === 0) return "(no tool windows)";
  // Cap rows so the prompt stays bounded — anything past the first 60
  // tool calls is rarely load-bearing for the checklist (the agent
  // tends to repeat snapshots).
  const capped = tw.slice(0, 60);
  const rows = capped.map((t, i) => {
    const input = (t.input ?? "").replace(/\s+/g, " ").slice(0, 120);
    const result = (t.result ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `${i + 1}. ${t.kind}${input ? `  input="${input}"` : ""}${result ? `  result="${result}"` : ""}`;
  });
  if (tw.length > capped.length) rows.push(`… (${tw.length - capped.length} more truncated)`);
  return rows.join("\n");
}

function buildPrompt(ctx: ChecklistContext): string {
  return PROMPT
    .replace("{{MIN_ITEMS}}", String(MIN_ITEMS))
    .replace("{{MAX_ITEMS}}", String(MAX_ITEMS))
    .replace("{{PR_TITLE}}", ctx.prTitle ?? "(not available)")
    .replace("{{PR_BODY}}", (ctx.prBody ?? "(not available)").slice(0, 4000))
    .replace("{{GOALS}}", formatGoals(ctx))
    .replace("{{ACTIONS}}", formatActions(ctx));
}

const MIN_ITEMS = CHECKLIST_MIN_ITEMS;
const MAX_ITEMS = CHECKLIST_MAX_ITEMS;
const MAX_LABEL = 36;
const MAX_NOTE = 64;

/** Hard cap on length, but cut at the last word boundary so we don't end
 *  up with "Today filte" or "Verify the foot…" — both look broken on
 *  the outro card. Adds an ellipsis only if we actually had to drop a
 *  whole word; an exact-fit just stays as-is. */
function clipToWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace < max * 0.6) return cut.trimEnd(); // word too long, just hard-cut
  return cut.slice(0, lastSpace).trimEnd() + "…";
}

function sanitise(items: any[]): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const outcome = raw.outcome === "failure" || raw.outcome === "skipped" ? raw.outcome : "success";
    const labelRaw = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim() : "";
    if (!labelRaw) continue;
    const label = clipToWord(labelRaw, MAX_LABEL);
    const note = typeof raw.note === "string" && raw.note.trim()
      ? clipToWord(raw.note.replace(/\s+/g, " ").trim(), MAX_NOTE)
      : undefined;
    out.push({ outcome, label, note });
    if (out.length >= MAX_ITEMS) break;
  }
  // Failures first, then successes, then skipped — guarantees important
  // items are never dropped by the MAX_ITEMS truncation upstream.
  out.sort((a, b) => orderRank(a.outcome) - orderRank(b.outcome));
  return out;
}

function orderRank(o: ChecklistItem["outcome"]): number {
  return o === "failure" ? 0 : o === "skipped" ? 2 : 1;
}

export async function generateChecklist(ctx: ChecklistContext): Promise<ChecklistItem[] | null> {
  if (ctx.artifacts.events.length === 0) return null;
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim(`  asking claude to synthesise the outro checklist…`));
  let raw: string;
  try {
    raw = await runClaude({ prompt, timeoutMs: NARRATION_TIMEOUT_MS, model: "sonnet", label: "checklist" });
  } catch (e) {
    console.log(chalk.yellow(`  checklist generation failed (${(e as Error).message.split("\n")[0]}); falling back to goal-level rows`));
    return null;
  }
  try {
    const json = extractJson(raw);
    const parsed = JSON.parse(json);
    const items = Array.isArray(parsed?.items) ? sanitise(parsed.items) : [];
    if (items.length < MIN_ITEMS) {
      console.log(chalk.yellow(`  checklist returned only ${items.length} items (<${MIN_ITEMS}); falling back to goal-level rows`));
      return null;
    }
    return items;
  } catch (e) {
    console.log(chalk.yellow(`  checklist JSON unparseable (${(e as Error).message.split("\n")[0]}); falling back to goal-level rows`));
    return null;
  }
}
