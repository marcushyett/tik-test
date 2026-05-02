import chalk from "chalk";
import type { TestPlan, Goal } from "./types.js";
import { NARRATION_TIMEOUT_MS } from "./timeouts.js";
import { runClaudeJson } from "./claude-cli.js";

/**
 * One CLICK-ANCHORED window of the body video. Windows partition the body
 * into segments separated by clicks (or click-clusters merged when very
 * close together). The narrator writes ONE beat per window. Each beat
 * plays for that window's full duration, so the spoken word is anchored
 * to the click that opens or closes the window — no drift possible.
 *
 * Why click-anchoring beats narrator-chosen timestamps: clicks are when
 * meaningful state changes happen on screen. Narration pinned to a click
 * is automatically pinned to the moment the viewer cares about.
 */
export interface NarrationWindow {
  idx: number;
  /** Body-relative seconds when this window begins. */
  startS: number;
  /** Body-relative seconds when this window ends. */
  endS: number;
  durS: number;
  /** The click that ENDS this window (fires at endS). null for the final
   *  window after the last click. The narrator can lead INTO this click
   *  ("we're about to hit Save"). */
  endingClick?: { tsS: number; element: string; tool: string };
  /** The click that STARTED this window (fired at startS). null for the
   *  first window before any click. The narrator can react TO this click
   *  ("now we see the toast appear"). */
  startingClick?: { tsS: number; element: string; tool: string };
  /** Other tool events that fired within [startS, endS], for context. */
  events: Array<{ startS: number; tool: string; description: string; result?: string }>;
}

export interface NarrationInput {
  plan: TestPlan;
  prTitle?: string;
  prBody?: string;
  focus?: string;
  /** Title-card window. */
  introTargetS: number;
  /** Master body duration in seconds. */
  bodyDurS: number;
  /** Outro window. */
  outroTargetS: number;
  /** Test plan goals — each goal is a chapter in the demo. */
  goals: Goal[];
  /** Click-anchored windows partitioning the body. The narrator writes
   *  one beat per window in order; durations are FIXED to the window. */
  windows: NarrationWindow[];
}

export interface NarrationLine {
  text: string;
  captionText: string;
}

/** One narrator-written beat for a click window. Empty text = silent gap. */
export interface WindowBeat extends NarrationLine {
  windowIdx: number;
}

/** A badge keyed to a window's silent investigative tool event. */
export interface NarrationBadge {
  /** Index into NarrationInput.windows whose silent event this badge labels. */
  windowIdx: number;
  /** 4-7 word plain-English summary, e.g. "checking the today filter". */
  label: string;
  /** Optional terminal-style one-liner, max 60 chars. */
  detail?: string;
}

export interface NarrationOutput {
  intro: NarrationLine;
  body: { beats: WindowBeat[] };
  outro: NarrationLine;
  badges: NarrationBadge[];
}

/** Empirical wpm for openai gpt-4o-mini-tts at our default delivery rate. */
const WORDS_PER_SEC = 3.0;

function targetWords(durS: number): number {
  return Math.max(8, Math.round(durS * WORDS_PER_SEC));
}

const PROMPT = `You are the narrator of a 60-second video that walks a stranger through a feature a developer just built.

WHO IS WATCHING.
Imagine the viewer is a teammate or reviewer who has NEVER seen this codebase. They have ~60 seconds of attention and they need to leave the video understanding FOUR things, in order:
  1. WHAT was built — what the new feature is, named in plain English.
  2. WHY it matters — what problem it solves or what it improves.
  3. HOW it works — what the user does to use it, and what they should expect to see happen.
  4. WHETHER it works — for each goal in the test plan, did this video show the test PASSING (or failing visibly).

If the viewer can't answer those four questions after watching, the narration failed. That is the bar.

VOICE.
You are the developer who built this, sitting next to a colleague at their desk and walking them through what you shipped. Calm. Specific. You are not pitching, not hyping, not selling. Just showing your work and inviting feedback. The tone is "here's what I did, here's why, here's how I checked it works."

ASSETS YOU HAVE TO WORK WITH.
- The PR title and body — the developer's own writeup of the feature. Read this first. Use its actual language. Don't paraphrase "Today filter" into "the filter we have". Use the names the developer chose.
- The plan summary — Claude's reading of what the test plan is checking.
- The list of goals — the EXACT things this video proves. Each goal is one chapter in your demo.
- The click-anchored window list — the on-screen events you're narrating, with their exact times and the buttons / fields the agent clicked.
- The events inside each window — what happened on screen between clicks (navigation, typing, investigation).

THINK FIRST. Do this before writing any beats:

STEP 1 — Read the PR body / focus and answer in your head: "If a viewer asked me 'so what does this feature do?', what's my one-sentence answer using the developer's own vocabulary?" That sentence is the seed of the INTRO.

STEP 2 — Read the GOALS. Each goal is a chapter in the demo. Decide the rough story arc:
  • Goal 1: introduce it, show it being tested, confirm it works.
  • Goal 2: same.
  • etc.
  Some windows in the body are "setup", some are "executing", some are "confirming". Map every window to one role.

STEP 3 — For each click in the WINDOWS list, name what the click DOES in the feature's vocabulary, not in mechanical terms:
  • Bad: "we click the button at the top right".
  • Good: "I'm hitting the new Bulk Archive button I just added at the top of the list".
  Use the element description in the click data (it's literally what the developer or DOM said the button was called) and tie it back to the feature you described in the intro.

STEP 4 — Write each window's beat. RULES PER BEAT:
  • Lead INTO the click that closes the window OR react TO the click that opened it. Beats anchor to clicks. The viewer just saw or is about to see that click.
  • Setup pattern (window before a click): "now we want to check that <goal> works. I'm going to <action> and we should see <expected outcome>." Then the click fires.
  • Confirm pattern (window after a click): "and yep, <expected outcome happened>" or "hmm, that didn't work — <expected> but we got <actual>." Then the next setup begins.
  • Specific over abstract. "Save", "Today filter", "priority badge" — name the actual UI element by the name it has on screen. The developer named these things; honour their names.
  • Connect goal to goal. When you finish one chapter, briefly bridge to the next: "alright, that's the count working. Next thing on my list is checking the empty state."
  • Word budget = window durS × 3 words/sec, ±15%. UNDER means silence; OVER means rushed audio. Most windows are 3–8s, so 9–24 words.

STEP 5 — INTRO and OUTRO.
  • INTRO (≈{{INTRO_WORDS}} words): name the feature in plain English, name the problem it solves, foreshadow the demo. Example shape: "I shipped a Bulk Archive option for the task list. Up until now you had to clear completed tasks one at a time, which gets tedious past five or six. Let me walk you through the new flow and how I'm checking it doesn't break anything else."
  • OUTRO (≈{{OUTRO_WORDS}} words): one sentence inviting input. Examples: "let me know if the confirm dialog feels heavy — I almost cut it" / "open question: should bulk-archive also include high-priority tasks, or only low?"

EXAMPLES OF GOOD vs BAD BEATS:

  Bad (mechanical, no feature context, viewer learns nothing):
    "the agent clicks the button and waits for the page to update."
  Good (specific, anchored, names the feature):
    "now I'm hitting Bulk Archive on the five tasks I selected. The counter top-right should drop from twelve to seven."

  Bad (filler, no continuity):
    "now we'll see what happens."
  Good (sets up the next click, names the goal):
    "next thing on my list is the empty state. I'll archive the last task and we should see the friendly 'all clear' card."

  Bad (jargon, technical):
    "querying the dataset to confirm the model state."
  Good (human voice for silent investigation):
    "let me double-check the count actually decreased in the data, not just the UI."

  Bad (drama / banned phrasing):
    "moment of truth, drum roll, here we go!"
  Good (calm, declarative):
    "alright, archiving."

OK TO SKIP A WINDOW. If a window is genuinely <1.5s of dead air or a transition with nothing meaningful to say, leave its beat text as "" (empty string). The video plays a silent gap, which is much better than 4-word filler that breaks the flow. Use sparingly — most windows should have a beat.

STRICT RULES:
- ONE CONTINUOUS DEMO. Each beat builds on the previous. No jumping topics. The viewer can follow the thread from intro to outro.
- HUMAN VOICE. The narrator is the developer, not a robot. Watchers should never feel they're listening to a tool log.
- NARRATE WHY, NOT WHAT. The visuals show WHAT. Your voice adds WHY/INTENT and what to look for.
- BANNED VOCABULARY — never appears in narration text or captionText:
  • Tool names: "snapshot", "screenshot", "browser snapshot", "DOM", "evaluate", "fetch", "querySelector", "API call", "browser_X" prefix.
  • Process language: "the agent", "automation", "tool call", "playwright", "MCP", "framework".
  • These belong in the per-window BADGES (below), never the voice.
- HUMAN-VOICE REPLACEMENTS for moments where the page sits while we investigate:
  • "let me take a closer look at this", "want to make sure I'm reading this right", "double-checking what we got back".
  • Failed / retry / timeout: "oops, missed that, let me try again", "hang on, that didn't catch — one more time".
  • Verifying state: "yep, that's what I expected", "exactly the value we wanted".
- BANNED PHRASES, never use these or close paraphrases:
  "moment of truth", "here we go", "let's see", "watch this", "drum roll", "the big reveal",
  "here's the moment", "and... there it is", "ready for prod", "ship it", "good to go",
  "looks clean", "we're golden", "magic happens".
- PUNCTUATION: do NOT use em-dashes (—) anywhere. Use commas, colons, or periods. Em-dashes break TTS pacing AND fragment on-screen subtitles.
- When something breaks: state plainly — "that's not right, the Today filter is empty even though we just added one." Expected vs actual. No drama.

For each window whose events include silent investigative tools (browser_evaluate / fetch / network / console), you MAY emit a BADGE — a tiny on-screen card that pops up while the page sits. The badge says WHAT technically; your voice (the matching beat) tells WHY.
- badgeLabel: 4-7 word plain-English summary of what's being checked.
- badgeDetail (optional): terminal-style one-liner, ≤60 chars.

Output STRICT JSON (no markdown, no prose, no thinking preamble):
{
  "intro": { "text": string, "captionText": string },
  "body": { "beats": [ { "windowIdx": number, "text": string, "captionText": string } ] },
  "outro": { "text": string, "captionText": string },
  "badges": [ { "windowIdx": number, "label": string, "detail"?: string } ]
}

Beats: exactly one per window, in order (windowIdx 0, 1, 2, …). Use empty text "" for windows you choose to skip.

CONTEXT:
Plan name: {{NAME}}
Plan summary: {{SUMMARY}}
Target URL: {{URL}}

PR title: {{PR_TITLE}}
PR body (why this change matters):
{{PR_BODY}}

Focus / changes notes:
{{FOCUS}}

GOALS (the demo's chapter titles — narrate them in order):
{{GOALS}}

CLICK-ANCHORED WINDOWS (each beat covers one window in order):
{{WINDOWS}}

Return only the JSON.`;

function buildPrompt(ctx: NarrationInput): string {
  const goals = ctx.goals.length
    ? ctx.goals.map((g, i) => `   ${i + 1}. ${g.intent}${g.success ? `\n      success: ${g.success}` : ""}`).join("\n")
    : "   (no goals provided — treat the body as a single uncategorised demo)";

  const windows = ctx.windows.map((w) => {
    const target = targetWords(w.durS);
    const lines: string[] = [];
    lines.push(`   window ${w.idx}: t=${w.startS.toFixed(1)}–${w.endS.toFixed(1)}s · ${w.durS.toFixed(1)}s · ≈${target} words`);
    if (w.startingClick) {
      lines.push(`     opened by click at ${w.startingClick.tsS.toFixed(1)}s on: ${w.startingClick.element || "(no description)"}`);
    } else {
      lines.push(`     opens the body (no click yet — set the scene)`);
    }
    if (w.events.length) {
      const evt = w.events.slice(0, 6).map((e) => `       · t=${e.startS.toFixed(1)}s ${e.tool}${e.description ? `: ${e.description}` : ""}${e.result ? ` → ${e.result}` : ""}`).join("\n");
      lines.push(`     events while the page sits:\n${evt}`);
    }
    if (w.endingClick) {
      lines.push(`     closed by click at ${w.endingClick.tsS.toFixed(1)}s on: ${w.endingClick.element || "(no description)"}`);
    } else {
      lines.push(`     closes the body (no click after — wrap up)`);
    }
    return lines.join("\n");
  }).join("\n\n");

  return PROMPT
    .replace("{{INTRO_WORDS}}", String(targetWords(ctx.introTargetS)))
    .replace("{{OUTRO_WORDS}}", String(targetWords(ctx.outroTargetS)))
    .replace("{{NAME}}", ctx.plan.name ?? "")
    .replace("{{SUMMARY}}", ctx.plan.summary ?? "")
    .replace("{{URL}}", ctx.plan.startUrl ?? "")
    .replace("{{PR_TITLE}}", ctx.prTitle ?? "(not available)")
    .replace("{{PR_BODY}}", (ctx.prBody ?? "(not available)").slice(0, 4000))
    .replace("{{FOCUS}}", (ctx.focus ?? "(not available)").slice(0, 2000))
    .replace("{{GOALS}}", goals)
    .replace("{{WINDOWS}}", windows || "   (no windows — narrate the URL as one beat)");
}

/**
 * Generate the narration script — intro + per-window body beats + outro
 * — in a single Claude call. Body beats are tied to click-anchored
 * windows whose timestamps are FIXED, so the spoken word stays locked to
 * the visual moment by construction.
 */
export async function generateNarration(ctx: NarrationInput): Promise<NarrationOutput> {
  if (ctx.windows.length === 0) {
    throw new Error("generateNarration called with zero windows — body has no time to fill");
  }
  const prompt = buildPrompt(ctx);
  console.log(chalk.dim(`  asking claude for click-anchored narration (intro + ${ctx.windows.length} body windows + outro, ${ctx.goals.length} goals)…`));
  // runClaudeJson retries on malformed JSON with the bad output fed back
  // — crucial for narration because the prompt asks for many freeform
  // strings (every window's text + captionText), each a chance for an
  // unescaped quote to break the parse and leave the video silent.
  const { value: parsed, attempts } = await runClaudeJson<NarrationOutput>({
    prompt, timeoutMs: NARRATION_TIMEOUT_MS, model: "sonnet",
    label: "narration", timeoutKnob: "TIK_NARRATION_TIMEOUT_MS",
  });
  if (attempts > 1) console.log(chalk.dim(`  narration parsed on attempt ${attempts}`));
  for (const key of ["intro", "outro"] as const) {
    const line = parsed[key];
    if (!line || typeof line.text !== "string" || !line.text.trim()) {
      throw new Error(`claude narration JSON is missing a non-empty "${key}.text"`);
    }
    if (typeof line.captionText !== "string" || !line.captionText.trim()) {
      line.captionText = line.text;
    }
  }
  if (!parsed.body || !Array.isArray(parsed.body.beats)) {
    throw new Error(`claude narration JSON is missing body.beats array`);
  }
  // Fill missing windowIdx slots with empty beats so the editor can rely on
  // a 1:1 mapping. Drop any out-of-range entries.
  const beatsByIdx = new Map<number, WindowBeat>();
  for (const b of parsed.body.beats) {
    if (typeof b?.windowIdx !== "number") continue;
    if (b.windowIdx < 0 || b.windowIdx >= ctx.windows.length) continue;
    beatsByIdx.set(b.windowIdx, {
      windowIdx: b.windowIdx,
      text: typeof b.text === "string" ? b.text.trim() : "",
      captionText: (typeof b.captionText === "string" && b.captionText.trim()) ? b.captionText.trim() : (typeof b.text === "string" ? b.text.trim() : ""),
    });
  }
  parsed.body.beats = ctx.windows.map((w) => beatsByIdx.get(w.idx) ?? { windowIdx: w.idx, text: "", captionText: "" });
  if (!Array.isArray(parsed.badges)) parsed.badges = [];
  parsed.badges = parsed.badges.filter((b) => {
    return typeof b?.windowIdx === "number"
      && b.windowIdx >= 0 && b.windowIdx < ctx.windows.length
      && typeof b.label === "string" && b.label.trim().length > 0;
  });
  return parsed;
}
