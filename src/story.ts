import { spawn } from "node:child_process";
import chalk from "chalk";
import type { PlanStep, StepEvent, TestPlan } from "./types.js";

export interface StoryContext {
  plan: TestPlan;
  events: StepEvent[];
  stepsById: Map<string, PlanStep>;
  prTitle?: string;
  prBody?: string;
  focus?: string;      // from claude.md
  visibleIndices: number[]; // indices into `events` that are included in the reel
}

export interface StoryStep {
  voiceLine: string;
  captionText: string;
  titleSlideLabel: string;
  titleSlideText: string;
}

export interface StoryOutput {
  intro: string;
  outro: string;
  steps: StoryStep[];
}

const PROMPT = `You are the narrator of a short video where you walk a colleague
through a new feature you just built. Picture a calm 1:1 screen-share — not a launch
demo, not a hype reel. You are quietly explaining your work and welcoming critique.

**Tonal rules (strict):**
- Open the video with WHY this feature exists and what PROBLEM it solves (use the
  PR body / motivation). Everything else hangs off that framing.
- The narration should read like ONE CONTINUOUS STORY about the feature. Each
  voiceLine should connect to the previous — refer back to what was just shown,
  set up what's coming. Avoid restating the action ("Now we click X") since the
  on-screen overlay already says that — instead, narrate the *intent* and the
  *story* ("once we save this, we should see it under Today…").
- BANNED PHRASES — never use any of these or close paraphrases:
  "moment of truth", "here we go", "let's see", "watch this", "drum roll",
  "the big reveal", "here's the moment", "and… there it is", "ready for prod",
  "ship it", "good to go", "looks clean", "we're golden", "magic happens".
- When something breaks or looks wrong, just say it plainly: "that's not right,
  the Today filter is empty even though we just added one" or "hmm, the count
  didn't update". State what was expected and what actually happened. No drama.
- The outro is one sentence asking for input or naming an open question.

**Format constraints:**
- voiceLine: **8–14 WORDS per step**. One short sentence. Keep it conversational
  and connected to the previous line. Per-tool overlays already narrate the
  micro-action — DON'T duplicate them, narrate the story-level thread.
- captionText: matches voiceLine WORD-FOR-WORD — the caption renderer syncs
  to the voice, so any mismatch shows up on screen as desync.
- titleSlideLabel: 1–2 word chapter tag, or empty string.
- titleSlideText: 2–5 word headline, or empty string.

Also produce:
  intro — 2 sentences (MAX 26 words). First names the PROBLEM from the PR
          body. Second previews what you'll demonstrate. Conversational, not
          marketing copy.
  outro — 1 sentence (MAX 16 words) asking for feedback or naming uncertainty.

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

/**
 * Generates the narration for the whole video via the `claude` CLI.
 *
 * This is a HARD requirement: every step's voice line, the intro, and the outro
 * are all written by Claude based on the PR context. There is no template
 * fallback — if this throws, the whole render aborts. tik-test pays for Claude
 * everywhere else (planning, goal-agent), so silently degrading to mechanical
 * templates here is the wrong behaviour: it hides a real environment bug
 * (missing CLI, busted auth, malformed prompt) behind a low-quality video.
 */
export async function generateStory(ctx: StoryContext): Promise<StoryOutput> {
  if (ctx.visibleIndices.length === 0) {
    throw new Error("generateStory called with zero visible events — nothing to narrate");
  }
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim("  asking claude to write the story narration…"));
  const raw = await runClaude(prompt);
  const json = extractJson(raw);
  let parsed: StoryOutput;
  try {
    parsed = JSON.parse(json) as StoryOutput;
  } catch (e) {
    throw new Error(`claude returned unparseable JSON for narration: ${(e as Error).message.split("\n")[0]}\n--- raw output (first 500 chars) ---\n${raw.slice(0, 500)}`);
  }
  if (!parsed.steps || !Array.isArray(parsed.steps)) {
    throw new Error(`claude narration JSON is missing a "steps" array`);
  }
  if (parsed.steps.length !== ctx.visibleIndices.length) {
    throw new Error(`claude returned ${parsed.steps.length} step lines but the plan has ${ctx.visibleIndices.length} visible events — re-run, or tighten the prompt to enforce the count`);
  }
  if (!parsed.intro || !parsed.outro) {
    throw new Error(`claude narration JSON is missing intro/outro lines`);
  }
  return parsed;
}
