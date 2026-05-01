import chalk from "chalk";
import type { TestPlan } from "./types.js";
import { NARRATION_TIMEOUT_MS } from "./timeouts.js";
import { runClaude, extractJson } from "./claude-cli.js";

/**
 * One on-screen moment the body video shows. Each moment carries a
 * body-relative timestamp + a human-readable description of what the
 * agent did. The narrator uses this timeline to ANCHOR each spoken
 * beat to its real on-screen moment — without timestamps, a single
 * continuous voice over the body drifts away from the visuals within
 * 10-15 seconds.
 */
export interface BodyMoment {
  /** Body-relative seconds — when this moment begins in the trimmed master. */
  startS: number;
  /** "silent" → the agent is investigating without visible UI change.
   *  "visible" → click/type/etc. that the viewer can see. Used to decide
   *  whether to render a small ToolBadge during this window. */
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
  /** Master body duration in seconds. Beats must cover [0, bodyDurS]. */
  bodyDurS: number;
  /** Outro window (before the post-voice hold). */
  outroTargetS: number;
  /** What happens on screen, in order — anchors for the narrator. */
  bodyMoments: BodyMoment[];
}

export interface NarrationLine {
  /** Spoken text, becomes the TTS source. */
  text: string;
  /** Caption text — must match `text` word-for-word for the on-screen
   *  subtitle to stay synced. */
  captionText: string;
}

/**
 * One narrator-defined beat in the body timeline. The narrator picks
 * BOTH the timestamp AND the duration based on what's on screen, so the
 * audio TTS for this beat plays exactly when the corresponding visual
 * moment happens. Per-beat audio = anchored sync by construction.
 */
export interface BodyBeat extends NarrationLine {
  /** Body-relative seconds when this beat begins. Must be sorted +
   *  non-overlapping across the body. The first beat starts at 0. */
  startS: number;
  /** Wall-clock duration of this beat in the composition. The narrator
   *  picks this so they own the word budget — `~durS * 3` words. */
  durS: number;
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
  /** Body narration as a TIMED beat list. Beats are sorted, non-overlapping,
   *  and cover [0, bodyDurS]. Each beat is TTS'd separately and placed at
   *  its declared startS so the spoken word lines up with the visuals. */
  body: { beats: BodyBeat[] };
  outro: NarrationLine;
  badges: NarrationBadge[];
}

/** Empirical wpm for openai gpt-4o-mini-tts at our default delivery rate. */
const WORDS_PER_SEC = 3.0;

function targetWords(durS: number): number {
  return Math.max(8, Math.round(durS * WORDS_PER_SEC));
}

const PROMPT = `You are the narrator of a short developer screen-share. Picture a calm 1:1 — not a launch demo, not a hype reel — quietly walking a colleague through what you just shipped and welcoming critique.

The video has THREE sections: an intro title card, the body recording, and an outro card.

INTRO line: ≈{{INTRO_WORDS}} words, names WHY this feature exists and what PROBLEM it solves (use the PR body / focus).
OUTRO line: ≈{{OUTRO_WORDS}} words, ONE sentence asking for input or naming an open question. Don't summarise what was shown.

BODY: a TIMED list of beats over the {{BODY_DUR}}s recording. THIS IS THE HARD PART.

Each beat is { "startS": number, "durS": number, "text": string, "captionText": string }. Each beat is TTS'd separately and placed at its declared startS in the final composition, so the spoken word lands EXACTLY when the corresponding visual happens. Without this, narration drifts away from the visuals within 10-15 seconds and the video feels broken.

Strict rules for the body beats:
- The FIRST beat starts at 0. The beats are sorted by startS. The LAST beat ENDS at {{BODY_DUR}}s (its startS + durS = {{BODY_DUR}}).
- Beats are NON-OVERLAPPING and CONTIGUOUS — beat[i+1].startS = beat[i].startS + beat[i].durS exactly.
- Anchor each beat to the BODY MOMENT TIMELINE below. If something visible happens at t=5.4s (e.g. the Today filter is clicked), the beat that talks about it should START at or just before 5.4s. Do not narrate an action that hasn't happened yet, and do not narrate an action 4 seconds after it's already off-screen.
- Each beat's text is sized for ~3 words/sec of speech. With durS={{EX_DUR}}s, that's ~{{EX_WORDS}} words. Stay within ±15% of the per-beat target — going under leaves silence, going over chipmunks the audio.
- 4-12 body beats total. Shorter (2-4s) for tight reactions; longer (5-9s) when the agent is doing something extended like typing or reading. Pick whatever cadence fits the visual story.

Tonal rules (strict, apply to ALL text and captionText):
- The narrator is a HUMAN developer talking through their own work. Watchers should never feel they're listening to a robot.
- Each beat connects to the previous — refer back, set up what's next. ONE CONTINUOUS STORY.
- Narrate WHY/INTENT, not WHAT/MECHANISM. "once we save this, we should see it under Today…" beats "now we click X".
- BANNED VOCABULARY — never appears anywhere in narration text or captionText, even paraphrased:
  • Tool names: "snapshot", "screenshot", "browser snapshot", "DOM", "evaluate", "fetch", "querySelector", "API call", "browser_X" prefix.
  • Process language: "the agent", "automation", "tool call", "playwright", "MCP", "framework".
  • These are correct words for the per-moment BADGES below, never the voice.
- HUMAN-VOICE REPLACEMENTS for moments where the page sits while we investigate:
  • "let me take a closer look at this", "want to make sure I'm reading this right", "double-checking what we got back".
  • Failed/retry/timeout → "oops, missed that, let me try again", "hang on, that didn't catch — one more time".
  • Verifying state → "yep, that's what I expected", "exactly the value we wanted".
- BANNED PHRASES, never use these or close paraphrases:
  "moment of truth", "here we go", "let's see", "watch this", "drum roll", "the big reveal",
  "here's the moment", "and... there it is", "ready for prod", "ship it", "good to go",
  "looks clean", "we're golden", "magic happens".
- PUNCTUATION: do NOT use em-dashes (—) anywhere in text or captionText. Use commas, colons, or periods. Em-dashes break TTS pacing AND fragment the on-screen subtitles.
- When something breaks or looks wrong, just say it plainly: "that's not right, the Today filter is empty even though we just added one." State expected vs actual. No drama.

For each SILENT moment in the timeline below (visibility=silent), also produce a BADGE — a tiny on-screen card that pops up while the page sits. The badge says WHAT technically; your voice (in the matching beat) tells WHY.
- badgeLabel: 4-7 word plain-English summary of what's being checked.
- badgeDetail (optional): terminal-style one-liner, ≤60 chars, e.g. "evaluate document.querySelectorAll('[data-priority=high]')".

Output STRICT JSON (no markdown, no prose, no comments):
{
  "intro": { "text": string, "captionText": string },
  "body": { "beats": [ { "startS": number, "durS": number, "text": string, "captionText": string } ] },
  "outro": { "text": string, "captionText": string },
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

BODY MOMENTS (in playback order — the narrator anchors body beats to these timestamps):
{{MOMENTS}}

Return only the JSON.`;

function buildPrompt(ctx: NarrationInput): string {
  const moments = ctx.bodyMoments.map((m, i) => {
    const head = `   ${i}. t=${m.startS.toFixed(1)}s · ${m.visibility} · ${m.toolKind}`;
    const inp = m.toolInput ? ` input="${m.toolInput.replace(/\s+/g, " ").slice(0, 160)}"` : "";
    const out = m.toolResult ? ` result="${m.toolResult.replace(/\s+/g, " ").slice(0, 160)}"` : "";
    return `${head}${inp}${out}`;
  }).join("\n");

  const exDur = 5;
  return PROMPT
    .replace("{{INTRO_WORDS}}", String(targetWords(ctx.introTargetS)))
    .replace("{{BODY_DUR}}", ctx.bodyDurS.toFixed(1))
    .replace(/\{\{BODY_DUR\}\}/g, ctx.bodyDurS.toFixed(1))
    .replace("{{OUTRO_WORDS}}", String(targetWords(ctx.outroTargetS)))
    .replace("{{EX_DUR}}", String(exDur))
    .replace("{{EX_WORDS}}", String(targetWords(exDur)))
    .replace("{{NAME}}", ctx.plan.name ?? "")
    .replace("{{SUMMARY}}", ctx.plan.summary ?? "")
    .replace("{{URL}}", ctx.plan.startUrl ?? "")
    .replace("{{PR_TITLE}}", ctx.prTitle ?? "(not available)")
    .replace("{{PR_BODY}}", (ctx.prBody ?? "(not available)").slice(0, 4000))
    .replace("{{FOCUS}}", (ctx.focus ?? "(not available)").slice(0, 2000))
    .replace("{{MOMENTS}}", moments || "   (no moments — narrate the URL alone, one beat covering the whole body)");
}

/**
 * Generate one coherent narration script — intro line, timed body beats,
 * outro line — in a single Claude call. The body is a TIMED LIST so each
 * spoken beat is anchored to a body-relative timestamp; per-beat audio
 * placed at its declared startS keeps the voice locked to the visuals.
 *
 * No fallback — if Claude fails, the whole render aborts. tik-test pays
 * for Claude everywhere else; silently degrading to mechanical templates
 * here would hide a real environment bug behind a low-quality video.
 */
export async function generateNarration(ctx: NarrationInput): Promise<NarrationOutput> {
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim(`  asking claude for timed narration (intro + ${ctx.bodyDurS.toFixed(0)}s body in beats + outro, ${ctx.bodyMoments.length} moments)…`));
  const raw = await runClaude({ prompt, timeoutMs: NARRATION_TIMEOUT_MS, model: "sonnet", label: "narration", timeoutKnob: "TIK_NARRATION_TIMEOUT_MS" });
  const json = extractJson(raw);
  let parsed: NarrationOutput;
  try {
    parsed = JSON.parse(json) as NarrationOutput;
  } catch (e) {
    throw new Error(`claude returned unparseable JSON for narration: ${(e as Error).message.split("\n")[0]}\n--- raw output (first 500 chars) ---\n${raw.slice(0, 500)}`);
  }
  for (const key of ["intro", "outro"] as const) {
    const line = parsed[key];
    if (!line || typeof line.text !== "string" || !line.text.trim()) {
      throw new Error(`claude narration JSON is missing a non-empty "${key}.text"`);
    }
    if (typeof line.captionText !== "string" || !line.captionText.trim()) {
      line.captionText = line.text;
    }
  }
  if (!parsed.body || !Array.isArray(parsed.body.beats) || parsed.body.beats.length === 0) {
    throw new Error(`claude narration JSON is missing a non-empty body.beats array`);
  }
  parsed.body.beats = normaliseBeats(parsed.body.beats, ctx.bodyDurS);
  if (!Array.isArray(parsed.badges)) parsed.badges = [];
  parsed.badges = parsed.badges.filter((b) => {
    const m = ctx.bodyMoments[b.momentIdx];
    return !!m && m.visibility === "silent" && typeof b.label === "string" && b.label.trim().length > 0;
  });
  return parsed;
}

/**
 * Defensive cleanup of the narrator's beat list. The narrator hits the
 * timing rules ~95% of the time, but a 5% drift (e.g. last beat ending at
 * 58.7s instead of 60.0s, or beats overlapping by 0.3s) will leave silence
 * gaps or audio collisions. We snap beats into a clean contiguous timeline
 * preserving each beat's text but adjusting startS / durS so:
 *   - first beat starts at exactly 0
 *   - last beat ends at exactly bodyDurS
 *   - beats are contiguous and non-overlapping
 *   - durations are scaled proportionally if the narrator's totals drifted
 */
function normaliseBeats(beats: BodyBeat[], bodyDurS: number): BodyBeat[] {
  // Validate every beat has text + captionText + finite numbers.
  const cleaned: BodyBeat[] = beats
    .filter((b) => b && typeof b.text === "string" && b.text.trim().length > 0)
    .map((b) => ({
      startS: Number.isFinite(b.startS) ? Math.max(0, b.startS) : 0,
      durS: Number.isFinite(b.durS) && b.durS > 0 ? b.durS : 1,
      text: b.text.trim(),
      captionText: (b.captionText ?? b.text).trim(),
    }))
    .sort((a, b) => a.startS - b.startS);
  if (cleaned.length === 0) {
    throw new Error("narration body has no usable beats after cleaning");
  }
  // Snap to contiguous coverage of [0, bodyDurS]. Each beat keeps its
  // proportional share of the original total duration so the narrator's
  // pacing intent survives the snap.
  const totalDeclared = cleaned.reduce((s, b) => s + b.durS, 0);
  let cursor = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const b = cleaned[i];
    const proportional = (b.durS / totalDeclared) * bodyDurS;
    const isLast = i === cleaned.length - 1;
    const newDur = isLast ? Math.max(0.5, bodyDurS - cursor) : Math.max(0.5, proportional);
    cleaned[i] = { ...b, startS: cursor, durS: newDur };
    cursor += newDur;
  }
  return cleaned;
}
