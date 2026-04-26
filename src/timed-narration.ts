import { spawn } from "node:child_process";
import chalk from "chalk";
import type { TestPlan } from "./types.js";

/**
 * One narration "scene" — a slot in the final video that needs spoken
 * narration. Scenes come in playback order and their start times are in
 * the FINAL composition timeline (intro at 0, body scenes follow, outro
 * last). The narrator uses the start times AND the target duration to
 * write a line that fits, so back-to-back TTS audio leaves no silence.
 */
export interface NarrationScene {
  id: string;
  kind: "intro" | "moment" | "outro";
  /** Start in the final composition timeline, in seconds. */
  startS: number;
  /** Time available before the next scene starts (or, for the last scene,
   *  before the composition ends). The narrator should write a line that
   *  takes roughly this long to read aloud at ~2.5 words/sec. */
  targetDurS: number;
  /** Free-form context for the narrator: what's on screen, what the agent
   *  is doing, why this moment matters. Plain English. */
  context: string;
  /** Tool kind (browser_click, browser_evaluate, …) — gives the narrator
   *  a hint about whether this is a visible interaction or silent thinking. */
  toolKind?: string;
  /** Raw input the tool was given (selector, value, url, …). Used so the
   *  narrator can name the actual element when relevant. */
  toolInput?: string;
  /** Tool result, truncated. Lets the narrator say what was found. */
  toolResult?: string;
  /** "silent": agent investigating, no visible UI change → narration line
   *  is paired with a small overlay BADGE so the viewer sees what's
   *  happening. "visible": user-visible interaction (click, type) → no
   *  badge, just narration. "intro"/"outro" only used for those kinds. */
  visibility: "silent" | "visible" | "intro" | "outro";
}

export interface NarrationContext {
  plan: TestPlan;
  prTitle?: string;
  prBody?: string;
  focus?: string;
  scenes: NarrationScene[];
}

export interface NarrationChunk {
  /** voiceLine — what the narrator will speak. Becomes the TTS source. */
  text: string;
  /** captionText — must match `text` word-for-word so the on-screen
   *  caption stays in sync with the voice. */
  captionText: string;
  /** Plain-English overlay label for silent investigation scenes only.
   *  Empty/undefined for visible interactions and intro/outro. */
  badgeLabel?: string;
  /** Terminal-style technical detail (e.g. `click [data-testid=add]`).
   *  Empty/undefined for visible interactions and intro/outro. */
  badgeDetail?: string;
}

export interface TimedNarration {
  /** One chunk per scene, same order as input. */
  chunks: NarrationChunk[];
}

/**
 * Words per second at the OpenAI gpt-4o-mini-tts default delivery rate.
 * Empirically ~2.9-3.1 wps once the Remotion audio playbackRate is allowed
 * to run a touch above 1.0. We use 3.0 to bias the narrator toward longer
 * lines — under-writing leaves silent tails that the playbackRate clamp
 * can't stretch out, and that's the dominant cause of audio coverage gaps.
 */
const WORDS_PER_SEC = 3.0;
/** Hard floor — even a 1.6s chunk gets at least 5 words so the line lands
 *  as a coherent thought rather than a 2-word fragment. */
const MIN_WORDS = 5;

function targetWords(targetDurS: number): number {
  return Math.max(MIN_WORDS, Math.round(targetDurS * WORDS_PER_SEC));
}

const PROMPT = `You are the narrator of a short video where a developer walks a colleague through a feature they just built. Picture a calm 1:1 screen-share — not a launch demo, not a hype reel. You are quietly explaining your work and welcoming critique.

The video has a fixed timeline. Every scene below has a TARGET DURATION and a TARGET WORD COUNT (~3 words per second of speech). Your narration line for that scene must hit that word count, **never less than 90% of target** — the whole video's audio is chained back-to-back from these lines, so an undersized line leaves audible silence between scenes (the editor cannot stretch a line to fill a gap; it can only speed it up to fit). Going slightly over is fine — the editor speeds up to 1.6× if needed — but going under leaves dead air, which is the worst failure mode.

**Tonal rules (strict):**
- The intro names WHY this feature exists and what PROBLEM it solves (use the PR body / focus).
- Each line connects to the previous — refer back, set up what's next. ONE CONTINUOUS STORY across scenes.
- Per-tool BADGES already say WHAT the agent is doing on silent moments. So narrate the WHY/INTENT, not the action ("once we save this, we should see it under Today…"), not ("now we click X").
- BANNED PHRASES — never use any of these or close paraphrases:
  "moment of truth", "here we go", "let's see", "watch this", "drum roll",
  "the big reveal", "here's the moment", "and… there it is", "ready for prod",
  "ship it", "good to go", "looks clean", "we're golden", "magic happens".
- When something breaks or looks wrong, just say it plainly: "that's not right, the Today filter is empty even though we just added one" or "hmm, the count didn't update". State expected vs actual. No drama.
- The outro is one sentence asking for input or naming an open question.

**Per-chunk format:**
- text: the spoken line. Hit the target word count for the scene (within ±20%).
- captionText: identical to text, word-for-word (the caption renderer syncs to the voice; any mismatch shows up on screen as desync).
- badgeLabel: ONLY for SILENT scenes (kind=silent). 4-7 word plain-English summary of what the agent is checking. Otherwise omit.
- badgeDetail: ONLY for SILENT scenes. Terminal-style one-liner, max 60 chars (e.g. \`evaluate document.querySelectorAll(...)\`, \`fetch /api/today\`). Otherwise omit.

Output STRICT JSON (no markdown, no prose):
{
  "chunks": [
    { "text": string, "captionText": string, "badgeLabel"?: string, "badgeDetail"?: string },
    ...  // EXACTLY one per scene, in order
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

SCENES (in playback order — write one chunk per scene):
{{SCENES}}

Return only the JSON.`;

function buildPrompt(ctx: NarrationContext): string {
  const sceneLines = ctx.scenes.map((s, i) => {
    const tw = targetWords(s.targetDurS);
    const head = `${i + 1}. ${s.kind.toUpperCase()} (visibility=${s.visibility}, target ${s.targetDurS.toFixed(1)}s ≈ ${tw} words)`;
    const lines = [head, `   context: ${s.context.replace(/\s+/g, " ").slice(0, 600)}`];
    if (s.toolKind) lines.push(`   tool: ${s.toolKind}${s.toolInput ? ` input="${s.toolInput.replace(/\s+/g, " ").slice(0, 200)}"` : ""}${s.toolResult ? ` result="${s.toolResult.replace(/\s+/g, " ").slice(0, 200)}"` : ""}`);
    return lines.join("\n");
  }).join("\n\n");

  return PROMPT
    .replace("{{NAME}}", ctx.plan.name ?? "")
    .replace("{{SUMMARY}}", ctx.plan.summary ?? "")
    .replace("{{URL}}", ctx.plan.startUrl ?? "")
    .replace("{{PR_TITLE}}", ctx.prTitle ?? "(not available)")
    .replace("{{PR_BODY}}", (ctx.prBody ?? "(not available)").slice(0, 4000))
    .replace("{{FOCUS}}", (ctx.focus ?? "(not available)").slice(0, 2000))
    .replace("{{SCENES}}", sceneLines);
}

function runClaude(prompt: string, timeoutMs = 360_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Sonnet is fast enough for templated narration (12-16 short chunks) and
    // keeps the editor under 90s on this stage. Opus on the same prompt was
    // hitting 4-minute timeouts on PR runs with 20+ scenes.
    const child = spawn("claude", ["-p", prompt, "--output-format", "text", "--model", "sonnet"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
 * Generate ONE coherent narration script for the whole video in a single
 * Claude call. The scene list comes from the editor AFTER the trim plan
 * is computed, so timing is exact: each chunk is sized to its scene's
 * target duration, TTS'd, then chained back-to-back so the final video
 * has continuous voice and captions with zero stacking and zero silence.
 *
 * No fallback — if Claude fails, the whole render aborts. tik-test pays
 * for Claude everywhere else; silently degrading to mechanical templates
 * here would hide a real environment bug behind a low-quality video.
 */
export async function generateTimedNarration(ctx: NarrationContext): Promise<TimedNarration> {
  if (ctx.scenes.length === 0) {
    throw new Error("generateTimedNarration called with zero scenes — nothing to narrate");
  }
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim(`  asking claude to write timed narration for ${ctx.scenes.length} scenes…`));
  const raw = await runClaude(prompt);
  const json = extractJson(raw);
  let parsed: TimedNarration;
  try {
    parsed = JSON.parse(json) as TimedNarration;
  } catch (e) {
    throw new Error(`claude returned unparseable JSON for narration: ${(e as Error).message.split("\n")[0]}\n--- raw output (first 500 chars) ---\n${raw.slice(0, 500)}`);
  }
  if (!parsed.chunks || !Array.isArray(parsed.chunks)) {
    throw new Error(`claude narration JSON is missing a "chunks" array`);
  }
  if (parsed.chunks.length !== ctx.scenes.length) {
    throw new Error(`claude returned ${parsed.chunks.length} chunks but the video has ${ctx.scenes.length} scenes — re-run, or tighten the prompt to enforce the count`);
  }
  for (let i = 0; i < parsed.chunks.length; i++) {
    const c = parsed.chunks[i];
    if (!c?.text || typeof c.text !== "string") {
      throw new Error(`chunk #${i + 1} (scene "${ctx.scenes[i].id}") is missing text`);
    }
    if (!c.captionText || typeof c.captionText !== "string") {
      // Fall back to text — story.ts already taught us captions drift in practice.
      c.captionText = c.text;
    }
  }
  return parsed;
}
