import chalk from "chalk";
import type { TestPlan } from "./types.js";
import { NARRATION_TIMEOUT_MS } from "./timeouts.js";
import { runClaude, extractJson } from "./claude-cli.js";

/**
 * One on-screen moment the body video shows. The narrator gets the full
 * sequence as context (with timestamps) and writes ONE flowing script for
 * the entire body — no per-moment chunks. This gives us a single audio
 * file that plays start-to-end with zero possibility of mid-body silence.
 */
export interface BodyMoment {
  /** Body-relative seconds — when this moment begins in the trimmed master. */
  startS: number;
  /** "silent" → the agent is investigating without visible UI change.
   *  "visible" → click/type/etc. that the viewer can see. Used to decide
   *  whether to show a small ToolBadge overlay during this window. */
  visibility: "silent" | "visible";
  toolKind: string;
  toolInput?: string;
  toolResult?: string;
}

export interface NarrationInput {
  plan: TestPlan;
  prTitle?: string;
  prBody?: string;
  focus?: string;
  /** Title-card window. The intro narration is sized to this. */
  introTargetS: number;
  /** Master body duration in seconds. The body script is sized to this. */
  bodyDurS: number;
  /** Outro window (before the post-voice hold). */
  outroTargetS: number;
  /** What happens on screen, in order. The narrator references the timestamps
   *  so the script lands on the right moment without per-chunk slicing. */
  bodyMoments: BodyMoment[];
}

export interface NarrationLine {
  /** Spoken text, becomes the TTS source. */
  text: string;
  /** Caption text — must match `text` word-for-word for the on-screen
   *  subtitle to stay synced. */
  captionText: string;
}

export interface NarrationBadge {
  /** Index into `bodyMoments` that this badge labels. Only emitted for
   *  visibility=="silent" moments where a viewer would otherwise wonder
   *  what the agent is doing during a frozen-looking screen. */
  momentIdx: number;
  /** 4-7 word plain-English summary, e.g. "checking the today filter". */
  label: string;
  /** Optional terminal-style one-liner, max 60 chars, e.g. `fetch /api/today`. */
  detail?: string;
}

export interface NarrationOutput {
  intro: NarrationLine;
  body: NarrationLine;
  outro: NarrationLine;
  badges: NarrationBadge[];
}

/** Empirical wpm for openai gpt-4o-mini-tts at our default delivery rate. */
const WORDS_PER_SEC = 3.0;

function targetWords(durS: number): number {
  return Math.max(8, Math.round(durS * WORDS_PER_SEC));
}

const PROMPT = `You are the narrator of a short developer screen-share. Picture a calm 1:1 — not a launch demo, not a hype reel — quietly walking a colleague through what you just shipped and welcoming critique.

The video has THREE sections: an intro title card, the body recording, and an outro card. You write ONE narration LINE for the intro (≈{{INTRO_WORDS}} words), ONE script for the body (≈{{BODY_WORDS}} words to fit the {{BODY_DUR}}s recording), and ONE line for the outro (≈{{OUTRO_WORDS}} words). The body script plays as a single audio file over the recording — its pace will be slightly stretched or compressed (within 0.9×–1.5×) to fit, so hit the body word target within ±15%. Going under leaves silence; going modestly over speeds up a touch.

The body script is ONE continuous flowing narration. Refer to what's happening on screen using the moment timeline below — but write prose, not a list. The reader/listener should feel they're watching a person talk through their own work, with the camera happening to be on the screen.

Tonal rules (strict):
- The intro names WHY this feature exists and what PROBLEM it solves (use the PR body / focus).
- The body script weaves through the moments naturally. Connect actions to intent ("once we save this, we should see it under Today…"), not the action ("now we click X"). Ground each beat in WHY before WHAT.
- You are a HUMAN developer talking through the work, not an AI agent narrating its tool calls. Watchers should never feel they're listening to a robot.
- BANNED VOCABULARY — never appears in any text/captionText, even paraphrased:
  • Tool names: "snapshot", "screenshot", "browser snapshot", "DOM", "evaluate", "fetch", "querySelector", "API call", "browser_X" prefix.
  • Process language: "the agent", "automation", "tool call", "playwright", "MCP", "framework".
  • These are correct words for the per-moment BADGES below, never the voice.
- HUMAN-VOICE REPLACEMENTS for moments where the page sits while we investigate:
  • "let me take a closer look at this", "want to make sure I'm reading this right", "double-checking what we got back".
  • Failed/retry/timeout → "oops, missed that, let me try again", "hang on, that didn't catch — one more time".
  • Verifying state → "yep, that's what I expected", "exactly the value we wanted".
- BANNED PHRASES, never use any of these or close paraphrases:
  "moment of truth", "here we go", "let's see", "watch this", "drum roll", "the big reveal",
  "here's the moment", "and... there it is", "ready for prod", "ship it", "good to go",
  "looks clean", "we're golden", "magic happens".
- PUNCTUATION: do NOT use em-dashes (—) anywhere in text or captionText. Em-dashes read as a hard pause in TTS and double as caption page breaks, so they fragment the on-screen subtitles. Use commas, colons, or periods instead. Plain hyphens inside identifiers are fine.
- When something breaks or looks wrong, just say it plainly: "that's not right, the Today filter is empty even though we just added one." State expected vs actual. No drama.
- The outro is one sentence asking for input or naming an open question.

For each SILENT moment in the timeline below (visibility=silent), also produce a BADGE — a tiny on-screen card that pops up while the page sits. The badge says WHAT technically (your voice tells WHY/INTENT). Output one badge per silent moment, identified by its 0-based index in the timeline.
- badgeLabel: 4-7 word plain-English summary of what's being checked.
- badgeDetail (optional): terminal-style one-liner, ≤60 chars, e.g. "evaluate document.querySelectorAll('[data-priority=high]')".

Output STRICT JSON (no markdown, no prose):
{
  "intro":  { "text": string, "captionText": string },
  "body":   { "text": string, "captionText": string },
  "outro":  { "text": string, "captionText": string },
  "badges": [ { "momentIdx": number, "label": string, "detail"?: string } ]
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

BODY MOMENTS (in playback order — anchor your script to these timestamps):
{{MOMENTS}}

Return only the JSON.`;

function buildPrompt(ctx: NarrationInput): string {
  const moments = ctx.bodyMoments.map((m, i) => {
    const head = `${i}. t=${m.startS.toFixed(1)}s · ${m.visibility} · ${m.toolKind}`;
    const inp = m.toolInput ? ` input="${m.toolInput.replace(/\s+/g, " ").slice(0, 160)}"` : "";
    const out = m.toolResult ? ` result="${m.toolResult.replace(/\s+/g, " ").slice(0, 160)}"` : "";
    return `   ${head}${inp}${out}`;
  }).join("\n");

  return PROMPT
    .replace("{{INTRO_WORDS}}", String(targetWords(ctx.introTargetS)))
    .replace("{{BODY_WORDS}}", String(targetWords(ctx.bodyDurS)))
    .replace("{{BODY_DUR}}", ctx.bodyDurS.toFixed(0))
    .replace("{{OUTRO_WORDS}}", String(targetWords(ctx.outroTargetS)))
    .replace("{{NAME}}", ctx.plan.name ?? "")
    .replace("{{SUMMARY}}", ctx.plan.summary ?? "")
    .replace("{{URL}}", ctx.plan.startUrl ?? "")
    .replace("{{PR_TITLE}}", ctx.prTitle ?? "(not available)")
    .replace("{{PR_BODY}}", (ctx.prBody ?? "(not available)").slice(0, 4000))
    .replace("{{FOCUS}}", (ctx.focus ?? "(not available)").slice(0, 2000))
    .replace("{{MOMENTS}}", moments || "   (no moments — narrate the URL alone)");
}

/**
 * Generate ONE coherent narration script for the whole video in a single
 * Claude call. Three sections (intro, body, outro) each get one line; the
 * body line is a continuous script sized to the master video duration so a
 * single TTS call produces one audio file that plays start-to-end with no
 * mid-body silence by construction.
 *
 * No fallback — if Claude fails, the whole render aborts. tik-test pays
 * for Claude everywhere else; silently degrading to mechanical templates
 * here would hide a real environment bug behind a low-quality video.
 */
export async function generateNarration(ctx: NarrationInput): Promise<NarrationOutput> {
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim(`  asking claude for one narration script (intro + ${ctx.bodyDurS.toFixed(0)}s body + outro, ${ctx.bodyMoments.length} moments)…`));
  const raw = await runClaude({ prompt, timeoutMs: NARRATION_TIMEOUT_MS, model: "sonnet", label: "narration", timeoutKnob: "TIK_NARRATION_TIMEOUT_MS" });
  const json = extractJson(raw);
  let parsed: NarrationOutput;
  try {
    parsed = JSON.parse(json) as NarrationOutput;
  } catch (e) {
    throw new Error(`claude returned unparseable JSON for narration: ${(e as Error).message.split("\n")[0]}\n--- raw output (first 500 chars) ---\n${raw.slice(0, 500)}`);
  }
  for (const key of ["intro", "body", "outro"] as const) {
    const line = parsed[key];
    if (!line || typeof line.text !== "string" || !line.text.trim()) {
      throw new Error(`claude narration JSON is missing a non-empty "${key}.text"`);
    }
    if (typeof line.captionText !== "string" || !line.captionText.trim()) {
      // Fall back to the spoken line — captions occasionally drift in practice.
      line.captionText = line.text;
    }
  }
  if (!Array.isArray(parsed.badges)) parsed.badges = [];
  // Defensive: drop badges that point at non-existent or non-silent moments.
  parsed.badges = parsed.badges.filter((b) => {
    const m = ctx.bodyMoments[b.momentIdx];
    return !!m && m.visibility === "silent" && typeof b.label === "string" && b.label.trim().length > 0;
  });
  return parsed;
}
