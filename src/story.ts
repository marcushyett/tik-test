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

const PROMPT = `You are the narrator of a TikTok-style video walking through an automated UI test run of a new feature.

The video is 9:16 with bold captions + a voice-over. Tone: excited indie developer showing off a new build — punchy, casual, confident, honest when something breaks, sometimes cheeky. No robotic or corporate language. Never repeat stock phrases like "moment of truth" more than once across the whole video.

**BE BRIEF.** The whole video should be watchable in under 60 seconds. Every line below must be tight.

For each step produce:
  voiceLine   — spoken narration. MAX 8 WORDS. Fragment sentences are fine ("Then — boom, the badge"). MUST describe the action happening NOW. Connect to neighbouring beats so the reel reads as a single story. Mention the PR "why" only when it sharpens the line.
  captionText — on-screen word-by-word caption. MAX 5 WORDS. Lowercase, punchy, the memorable pull-quote from the line.
  titleSlideLabel — 1–2 word chapter tag (e.g. "the risky bit"). Empty string if the step doesn't deserve a pre-roll card.
  titleSlideText  — headline on the pre-roll card, 2–5 words. Empty string if no card.

Also produce:
  intro — 1 short sentence that hooks the viewer (MAX 14 words). Reference the feature.
  outro — 1 sentence wrap-up (MAX 12 words) saying whether it ships.

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
