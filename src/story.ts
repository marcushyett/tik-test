import { spawn } from "node:child_process";
import chalk from "chalk";
import type { PlanStep, StepEvent, TestPlan } from "./types.js";
import type { NarrationOutput } from "./narrator.js";

export interface StoryContext {
  plan: TestPlan;
  events: StepEvent[];
  stepsById: Map<string, PlanStep>;
  prTitle?: string;
  prBody?: string;
  focus?: string;      // from claude.md
  visibleIndices: number[]; // indices into `events` that are included in the reel
}

export interface StoryOutput {
  intro: string;
  outro: string;
  steps: Array<Pick<NarrationOutput, "voiceLine" | "captionText" | "titleSlideLabel" | "titleSlideText">>;
}

const PROMPT = `You are the narrator of a video walking colleagues through a new feature.

Imagine you *built* this change and you're screen-sharing in a team huddle, showing
what you made. The tone is: thoughtful, collegial, honest. You're proud of the work
but genuinely curious whether it's right — you're inviting feedback, not pitching.

**Tonal rules (strict):**
- Start the video by explaining WHY this feature exists and what PROBLEM it solves
  (use the PR body / motivation section). That framing anchors everything else.
- While narrating actions, REFER BACK to the problem. "This is the bit that used to
  force users to click-through-close-repeat…" "Here's where the new shortcut kicks in."
- If something breaks, unexpectedly pauses, or a number looks wrong — say **"oops"** or
  **"hmm, that's not what I expected"** or **"hold on, that's a bug"** on the spot. Be
  honest and specific. Bugs in the video are *good* — they're what we're looking for.
- NEVER say "ship it", "good to go", "let's ship", "ready for prod", "looks clean",
  or anything that makes a final pass/fail judgment. You're *asking*, not *declaring*.
- Outro should ask the team for feedback or surface an open question — something like
  "curious what you all think" or "one thing I'm still unsure about..."

**Format constraints:**
- voiceLine: **45–75 WORDS per step** — roughly 18–28 seconds of speech. This is
  substantial demo commentary, not a tagline. Walk through what's happening: name
  what you're about to click / type / press, explain the design choice, point out
  details to watch for, preview the next beat. Keep the tone conversational. Silence
  mid-step is bad — aim to keep talking the whole time.
- captionText: **TV-style subtitle that MATCHES the voiceLine word-for-word**, minor
  punctuation adjustments OK. The word-reveal caption component paces itself to the
  voice, so long text is fine.
- titleSlideLabel: 1–2 word chapter tag, or empty string.
- titleSlideText: 2–5 word headline, or empty string.

Also produce:
  intro — 2–3 sentences (30–50 words). First names the PROBLEM from the PR body.
          Second previews what you'll show. Third optionally teases a detail.
  outro — 1–2 sentences (20–35 words) that asks for feedback or flags something
          you're unsure about. NEVER a verdict.

Output STRICT JSON in the following shape (no markdown, no prose):
{
  "intro": string,
  "outro": string,
  "steps": [
    { "voiceLine": string, "captionText": string, "titleSlideLabel": string, "titleSlideText": string },
    ...  // one entry per step in the order given
  ]
}

CONTEXT:
Plan name: {{NAME}}
Plan summary: {{SUMMARY}}
Target URL: {{URL}}

PR title: {{PR_TITLE}}
PR body (why this change matters):
{{PR_BODY}}

Focus / changes notes:
{{FOCUS}}

STEPS (numbered in the order they'll play in the video):
{{STEPS}}

Return only the JSON.`;

function buildPrompt(ctx: StoryContext): string {
  const stepsDescribed = ctx.visibleIndices.map((i, vi) => {
    const ev = ctx.events[i];
    const step = ctx.stepsById.get(ev.stepId);
    const importance = step?.importance ?? ev.importance ?? "normal";
    const value = step?.value ? ` value="${step.value}"` : "";
    const target = step?.target ? ` target="${step.target}"` : "";
    return `${vi + 1}. kind=${ev.kind} importance=${importance} outcome=${ev.outcome} desc="${ev.description}"${value}${target}${ev.error ? ` error="${ev.error}"` : ""}`;
  }).join("\n");

  return PROMPT
    .replace("{{NAME}}", ctx.plan.name ?? "")
    .replace("{{SUMMARY}}", ctx.plan.summary ?? "")
    .replace("{{URL}}", ctx.plan.startUrl ?? "")
    .replace("{{PR_TITLE}}", ctx.prTitle ?? "(not available)")
    .replace("{{PR_BODY}}", (ctx.prBody ?? "(not available)").slice(0, 4000))
    .replace("{{FOCUS}}", (ctx.focus ?? "(not available)").slice(0, 2000))
    .replace("{{STEPS}}", stepsDescribed);
}

function runClaude(prompt: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude CLI timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err || out}`));
      resolve(out.trim());
    });
  });
}

function extractJson(text: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export async function generateStory(ctx: StoryContext): Promise<StoryOutput | null> {
  if (ctx.visibleIndices.length === 0) return null;
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim("  asking claude to write the story narration…"));
  const raw = await runClaude(prompt);
  try {
    const json = extractJson(raw);
    const parsed = JSON.parse(json) as StoryOutput;
    if (!parsed.steps || parsed.steps.length !== ctx.visibleIndices.length) {
      console.log(chalk.yellow(`  claude returned ${parsed.steps?.length ?? 0} step lines, expected ${ctx.visibleIndices.length} — falling back to templates`));
      return null;
    }
    return parsed;
  } catch (e) {
    console.log(chalk.yellow(`  couldn't parse claude story: ${(e as Error).message.split("\n")[0]} — falling back`));
    return null;
  }
}
