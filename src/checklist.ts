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
import { runClaudeJson } from "./claude-cli.js";
import { clipToWord } from "./text.js";

export interface ChecklistItem {
  outcome: "success" | "failure" | "skipped";
  label: string;
  note?: string;
  /** ID of the goal this check belongs to (matches StepEvent.stepId).
   *  Both the video outro and the PR comment GROUP rows by this so a
   *  reviewer can see which beat each sub-check belongs to. Missing
   *  goalIds are rendered under an "Unspecified" bucket as a safety
   *  net (an LLM may occasionally drop the field). */
  goalId?: string;
}

const PROMPT = `You are summarising what an automated QA agent actually checked while reviewing a pull request. The output is a CHECKLIST shown on the final frame of a short review video — a reviewer pauses on it and reads to learn what was tested, what worked, and what failed.

OUTPUT FORMAT — STRICT JSON, no markdown, no prose:
{
  "items": [
    { "outcome": "success" | "failure" | "skipped", "label": string, "note"?: string, "goalId": string },
    ... 6 to 12 entries
  ]
}

RULES:
- {{MIN_ITEMS}} to {{MAX_ITEMS}} items. Aim for the middle of that range — enough to feel substantive, few enough to scan in 5 seconds AND fit on a vertical 9:16 frame without scrolling.
- "goalId" is REQUIRED on every item — it MUST exactly match one of the goal IDs listed under "Plan goals" below (e.g. "g1", "_login"). Both the video outro and the PR comment GROUP items by their goalId so the reviewer can see which beat each sub-check belongs to. Items without a valid goalId render under a generic bucket and look broken.
- Each "label" is a specific CHECK that was performed: subject + verb form, ≤32 chars. Examples should be GENERIC subject+verb form ("Filter shows expected items", "Badge appears on first match", "Counter updates on action"). NOT goal-level summaries.
- The agent verifies via a 4-tier hierarchy: (1) UI screenshot, (2) freeze-the-moment + screenshot, (3) programmatic fallback (DOM/network/storage), (4) skipped — needs human. Map each OUTCOME to a row:
  • "success" — agent confirmed the behaviour, regardless of whether it used a screenshot (tier 1/2) or DOM probe (tier 3). All counted equally — the reviewer cares THAT it works, not WHICH method confirmed it.
  • "failure" — real regression: agent emitted OUTCOME: failure OR a screenshot contradicted the criterion.
  • "skipped" — tier-4 only (agent couldn't verify automatically). Note prefix optional but should mention what blocked verification.
- "note": MANDATORY for every row. PLAIN ENGLISH explaining HOW the check was done — what the agent did and what they saw. 6-14 words. Conversational, not technical. NO jargon: never write "via DOM", "DOM", "querySelector", "aria-busy", "textContent", "getBoundingClientRect", class names, hex colours, or pixel values. The reviewer should understand the test from the note alone.
  • Good (success): "Clicked the pin and watched the task jump to the top of the list."
  • Good (success): "Edited the title inline and confirmed the new text appeared after Enter."
  • Good (success): "Pinning a task showed a confirmation toast that read 'Pinned to top'."
  • Bad (jargon, opaque): "via DOM: index 0 confirmed, pinned class + gold border applied"
  • Bad (jargon, opaque): "via DOM: textContent changed to updated value"
  • Good (failure): "Clicked the filter but no items showed despite the TODAY badge."
  • Good (skipped): "Couldn't verify the 4K-only render automatically; needs a human eye."
- Order: failures first (so truncation never hides them), then successes, then skipped.
- Don't invent checks the agent didn't actually do. Read the action log carefully — every label must map to specific clicks/types/snapshots/screenshots.
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
      // Surface goalId explicitly so the LLM can reference it on each
      // checklist item — exact-match attribution is non-negotiable for
      // the grouped-by-goal rendering.
      `${i + 1}. id="${e.stepId}" [${e.outcome.toUpperCase()}] ${e.description.replace(/\s+/g, " ").slice(0, 220)}`,
    ];
    if (e.shortLabel) lines.push(`   GOAL HEADLINE: ${e.shortLabel}`);
    if (e.notes) lines.push(`   AGENT NOTE: ${e.notes.replace(/\s+/g, " ").slice(0, 200)}`);
    return lines.join("\n");
  }).join("\n");
}

function formatActions(ctx: ChecklistContext): string {
  // Filter out PASS-2 demo-replay tool windows (kind starts with "replay_").
  // Those are CHOREOGRAPHY for the recording, not new test signal — every
  // step they describe was already verified in pass 1, and the LLM kept
  // turning replay locator timeouts (a recording-engine glitch, not a
  // product bug) into spurious "X check failed" rows in the user's PR
  // comment. The pass-1 agent's verification notes (already in GOALS via
  // shortNote / notes) are the authoritative signal for what was tested.
  const tw = (ctx.artifacts.toolWindows ?? []).filter((t) => !t.kind.startsWith("replay_"));
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
const MAX_LABEL = 40;
// Notes are conversational plain-English now ("Added a new task, pinned it,
// and watched it rise to first place"). 64 chars cut almost every note
// mid-sentence with "…". 120 fits a typical 12-word sentence comfortably
// while still constraining a runaway LLM. The PR comment table column
// stretches to fit; on the outro the note wraps to a second line.
const MAX_NOTE = 120;

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
    const goalId = typeof raw.goalId === "string" && raw.goalId.trim()
      ? raw.goalId.trim().slice(0, 64)
      : undefined;
    out.push({ outcome, label, note, goalId });
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
  try {
    // runClaudeJson retries on parse failure with the bad output fed back
    // in — the LLM almost always self-corrects once shown its own
    // unescaped quote / trailing comma. Worth the extra CLI calls because
    // the fallback (one row per goal) hides the granular check data the
    // grouped outro is specifically designed to display.
    const { value, attempts } = await runClaudeJson<{ items?: unknown[] }>({
      prompt, timeoutMs: NARRATION_TIMEOUT_MS, model: "sonnet",
      label: "checklist", timeoutKnob: "TIK_NARRATION_TIMEOUT_MS",
    });
    if (attempts > 1) console.log(chalk.dim(`  checklist parsed on attempt ${attempts}`));
    const items = Array.isArray(value?.items) ? sanitise(value.items) : [];
    if (items.length < MIN_ITEMS) {
      console.log(chalk.yellow(`  checklist returned only ${items.length} items (<${MIN_ITEMS}); falling back to goal-level rows`));
      return null;
    }
    return items;
  } catch (e) {
    console.log(chalk.yellow(`  checklist generation failed (${(e as Error).message.split("\n")[0]}); falling back to goal-level rows`));
    return null;
  }
}
