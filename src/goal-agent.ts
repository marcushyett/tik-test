/**
 * Goal agent — drives the browser through Playwright MCP using the
 * `claude` CLI as the inference engine. The CLI handles the tool-use
 * loop natively: we give it a goal, an MCP config that points to
 * Playwright MCP, and restrict allowed tools to that MCP server. Output
 * is stream-json so we can capture every tool_use for our event stream.
 *
 * Playwright MCP connects to our already-running Playwright browser via
 * CDP (--cdp-endpoint), so video recording, cookies, and bypass header
 * routing on our Playwright context all stay intact while MCP drives.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import chalk from "chalk";
import type { BBox, DemoStep, Goal } from "./types.js";
import { AGENT_TIMEOUT_MS } from "./timeouts.js";

export interface GoalResult {
  /** "skipped" means the agent reached an honest "this can't be tested
   *  automatically" conclusion — neither UI nor programmatic verification
   *  worked. Distinct from "failure" so the PR check isn't marked red for
   *  things the agent simply couldn't reach. The PR comment surfaces
   *  these as "needs human verification" rows. */
  outcome: "success" | "failure" | "skipped";
  note?: string;
  /** 5-9 word headline of what happened, suitable for the on-video
   *  checklist. Falls back to a truncation of `note` if the agent fails
   *  to emit a SHORTNOTE line. */
  shortNote?: string;
  bbox?: BBox;
  /** One entry per tool call. `result` is a short string preview of the tool's
   *  output (truncated) so the video editor can overlay what the agent learned
   *  — e.g. during a silent browser_evaluate, the overlay shows the JS result
   *  instead of a static page. */
  actions: Array<{ kind: string; target?: string; value?: string; result?: string; ok: boolean; error?: string; startedAt?: number }>;
  /** Linear demo choreography emitted by the agent at end of goal. Pass-2
   *  replayer walks these with fixed dwell to produce a clean recording.
   *  Empty when the agent didn't emit STEPS (e.g. skipped goals); pass 2
   *  falls back to pass-1 video if NO goal emitted any steps. */
  steps?: DemoStep[];
}

// Per-mode safety ceilings. The default (fast) mode is a tight ceiling
// because the prompt forbids loops and rewards single-pass testing — 25
// turns is plenty when you're only allowed one retry per approach. We
// surface this number to the agent in the system prompt so it can
// prioritize the most important checks first and bail to "skipped" early
// rather than burning the budget on a single uncooperative probe. The
// meticulous mode raises the ceiling to 100 to give a thorough agent room
// to probe edge cases without the cap forcing it to wrap up early.
const MAX_TURNS_DEFAULT = 25;
const MAX_TURNS_METICULOUS = 100;
// Per-goal CLI runtime ceiling. Configurable via TIK_AGENT_TIMEOUT_MS env
// (or `agent-timeout` action input). Default 10 min. See src/timeouts.ts.
const CLAUDE_TIMEOUT_MS = AGENT_TIMEOUT_MS;

/** Whether the agent should run in extremely-meticulous mode. Toggled by
 *  `TIK_METICULOUS=1` (set by `--meticulous` on the CLI or the `meticulous`
 *  GitHub Action input). Default off — fast / no-loops / parallel-probes. */
function isMeticulous(): boolean {
  const v = process.env.TIK_METICULOUS;
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * FAST (default) prompt — VALIDATION pass.
 *
 * tik-test runs in TWO phases. Phase 1 (this prompt) is a verification
 * sprint: prove the feature works as fast as possible by ANY means
 * available — UI, DOM probes, fetch, time-travel buffer. The recording
 * from this pass is NOT shown to the viewer; it's debug only.
 *
 * Phase 2 (a deterministic replay) runs from the STEPS list this prompt
 * outputs at the end. THAT is what gets recorded for the viewer.
 *
 * So: don't act like a user. Don't pace yourself. Don't worry about
 * making clicks watchable. Just verify, then design the demo.
 */
function buildFastSystemPrompt(): string {
  return [
    "You have ONE job: figure out, as fast as humanly possible, whether the feature works — and then write the IDEAL demo of it for a viewer. The recording you produce while validating is NOT shown to anyone. It's debug. A second pass replays your demo plan deterministically, and THAT is what gets shipped to the reviewer.",
    "",
    "This means: stop pretending to be a user. You are an automated tester with full DOM access. Use whatever path is fastest:",
    "- Direct DOM probes via browser_evaluate (querySelector, getComputedStyle, dataset, ARIA attributes).",
    "- fetch() against the app's own endpoints from inside browser_evaluate.",
    "- Reading localStorage / sessionStorage / IndexedDB.",
    "- Setting `.value` on inputs, dispatching events, calling `.click()` on hidden controls — bypassing the UI is FINE here. The point is verification, not user-fidelity.",
    "- Time-travel buffer (`__tikHistory`) for anything that flashed by — chat messages, toasts, spinners, busy states, animation transitions.",
    "- If the page won't render the feature at all in your viewport, switch tabs / open new pages / hit different URLs — whatever the diff or PR notes suggest is the canonical surface.",
    "",
    `BUDGET: AT MOST ${MAX_TURNS_DEFAULT} turns. Bundle independent probes into ONE assistant message (multiple tool_use blocks in parallel) — that single move can prove three things in one round-trip. Use the budget aggressively. If after 20 turns you still don't have a clean verdict, emit OUTCOME: skipped and bail.`,
    "",
    "VERIFICATION HIERARCHY — pick the FASTEST tier that gives you confidence. You do NOT have to walk it top-down:",
    "  • Programmatic — querySelector / fetch / evaluate. Often the FASTEST path. Goes first when the feature is data-driven (a count updated, a record was saved, a class toggled, an aria-attribute flipped). Your OUTCOME starts with 'verified programmatically:' and names the DOM/network signal.",
    "  • Time-travel — `await __tikHistory.find({ text, sinceMs: 30000 })` for anything that already happened but isn't on screen. Chat replies, toasts, spinners, transient banners. Returns entries with text/bbox/sinceNowMs. OUTCOME starts with 'verified programmatically (time-travel):'.",
    "  • Freeze + screenshot — `await __tikFreeze.pause()` then screenshot then `__tikFreeze.resume()` — for sub-second visual transitions you need to SEE.",
    "  • UI screenshot — when the feature is purely visual (a layout, a colour change, a new element rendered). Take ONE.",
    "  • Skipped — emit `OUTCOME: skipped — needs human verification: <reason>` only when none of the above can give you a clean answer. This does NOT mark the PR check red.",
    "",
    "MISSING-CONTENT PROTOCOL — when you take an action and the snapshot/screenshot doesn't show what you expected, your IMMEDIATELY NEXT tool call is `__tikHistory.find({ text: '<expected>', sinceMs: 30000 })`. Not a retry. Not another screenshot. The buffer tells you whether the state existed and faded vs. never appeared. Cite the entry's `sinceNowMs` in your OUTCOME if it hits.",
    "",
    "STUCK-LOOP TRIPWIRE — same tool with same input twice and the page hasn't moved? STOP. Try ONE different verification path (e.g. switch from screenshot to evaluate). If that also fails, OUTCOME: skipped. Looping is the only way to fail this prompt; everything else is a valid outcome.",
    "",
    "Time-travel buffer reference (the tools `__tikHistory` exposes via browser_evaluate):",
    "  • `__tikHistory.find({ text, tag, testid, containerTestid, kind, sinceMs })` — filtered list. `kind` ∈ {'added', 'removed', 'text-changed', 'attr-changed'}. Each entry: `{ ts, sinceNowMs, tag, testid, containerTestid, ariaLabel, role, text, bbox, kind }`.",
    "  • `__tikHistory.transients(sinceMs)` — elements that appeared then disappeared (`addedAt`, `removedAt`, `durationMs`). Use for spinners and toasts.",
    "  • `__tikHistory.stats()` — buffer state (debugging your queries).",
    "  • `__tikFreeze.pause()` / `__tikFreeze.resume()` — pause / resume CSS animations + Web Animations API.",
    "",
    "Context:",
    "- The browser is ALREADY on the app's start URL. Login already happened in a separate phase if your tiktest.md declared credentials. Don't re-navigate to localhost.",
    "- Start with ONE browser_snapshot to read the current screen.",
    "- REVIEWER NOTES in the user message are AUTHORITATIVE — a reviewer has already tested this PR and is telling you the happy path. Follow their instructions first.",
    "- Don't force the environment into a precondition that isn't there. If the success criterion needs a 'first-time user' state but you see prior-session data (and a single localStorage clear + reload doesn't fix it), emit `OUTCOME: failure — precondition not satisfied — <what was wrong>`. Test-environment state pollution is the correct outcome to report; it's not a regression to be hunted around.",
    "",
    "Every goal ends with THREE blocks, in this order: OUTCOME, SHORTNOTE, STEPS.",
    "",
    "OUTCOME: success — full reason (≤30 words). Cite the specific signal you saw — the DOM check, the time-travel hit, the screenshot detail.",
    "SHORTNOTE: 5-9 word headline for the on-video checklist — ≤60 chars.",
    "",
    "OUTCOME: failure — full reason. Use ONLY when you actually tested and got a clearly wrong result. Expected vs actual.",
    "SHORTNOTE: 5-9 words naming WHAT broke.",
    "",
    "OUTCOME: skipped — needs human verification: <specific reason>. ONLY when no automated path can give you a clean answer.",
    "SHORTNOTE: 5-9 words naming WHY it can't be auto-tested.",
    "",
    "SHORTNOTE rules: no articles, no preamble, no apologies. Pass: name the WHO/WHAT that worked. Fail: name the EXPECTATION that failed. Skip: name the LIMITATION.",
    "",
    "STEPS — DESIGN THE PERFECT DEMO (required on success and failure; omit only for skipped):",
    "",
    "This is the most important part of your output. STEPS is NOT a transcript of what you just did — it is your CREATIVE BRIEF for a 8-15 second demo that makes this feature crystal-clear to a viewer who has never seen the app. You are the director.",
    "",
    "Pass 2 will replay these steps deterministically — slow, deliberate, narrated. Every click sits on screen for ~2 seconds, every action lands on the right beat. Your job is to design the SIMPLEST possible sequence of user actions that proves the feature works AND lets a viewer follow along.",
    "",
    "Format:",
    "STEPS:",
    "```json",
    "[",
    "  { \"kind\": \"click\",  \"label\": \"<visible button text>\",      \"role\": \"button\",   \"camera\": \"tight\", \"hint\": \"open the form\" },",
    "  { \"kind\": \"type\",   \"label\": \"<input label / placeholder>\", \"value\": \"<text>\",  \"camera\": \"tight\", \"hint\": \"name the new item\" },",
    "  { \"kind\": \"press\",  \"key\":   \"Enter\",                          \"camera\": \"follow\", \"hint\": \"submit\" },",
    "  { \"kind\": \"wait\",   \"ms\":    1500,                              \"camera\": \"wide\",   \"hint\": \"the result appears\" }",
    "]",
    "```",
    "",
    "Rules of good demo design:",
    "- 3 to 7 steps. Fewer is better. A demo with 4 clear steps beats one with 8 nuanced ones.",
    "- Each step must do something the viewer can VISUALLY observe — no invisible verification, no probes, no DOM hacks. Pass 2 replays via real clicks/typing only.",
    "- ALWAYS end with a `wait` step (1500-2500ms) so the viewer sees the RESULT of the last action with the narrator describing it. The wait's `hint` should describe what's now visible.",
    "- Don't pack actions. If two actions land on different surfaces, separate them with a `wait` step so the eye can catch up.",
    "- Use `hint` on every step. It's one short generic phrase the narrator works from. GENERIC: \"submit the form\", \"open the menu\", \"the item appears in the list\". NOT product-specific (\"add the task\", \"create the meeting\").",
    "- Pick the SIMPLEST happy path. If the feature has 5 ways to trigger it, pick the most obvious user-visible one. Skip edge cases the viewer doesn't need to learn from this clip.",
    "- Labels MUST be the user-visible text on screen — button text, input label, placeholder, link text. NO CSS selectors. NO Playwright refs. Pass 2 resolves via getByRole / getByLabel / getByText against a FRESH browser, so `label` has to match what's painted on the page.",
    "- For `click`/`select`, include `role` (button, link, textbox, combobox, etc.) when the label is short or could match multiple elements.",
    "",
    "Camera direction (`camera` field — choose deliberately, the camera is yours to direct):",
    "- This replaces the old reactive zoom rules entirely. You picked the demo, so you also pick where the viewer looks. Bad camera choices ruin a clear demo.",
    "- `tight`: zoom in on the action point. Use when ONE specific control is the subject — pressing a button, focusing a field, toggling a switch, hovering a badge. The viewer's eye snaps to that element.",
    "- `wide`: full-page view. Default. Use for context shots and for moments where the result spans the page (a list updates, a toast appears in the corner, multiple things change at once, the user needs to compare regions).",
    "- `follow`: start tight on the action, ease out to wide over the step's duration. Use when an action TRIGGERS a visible side effect ELSEWHERE on the page that the viewer needs to see — e.g. clicking a Save button that makes a row appear at the top, or pressing Enter that produces a toast in the corner.",
    "",
    "How to think about it: most of a demo should be `wide` (the viewer follows what's happening). `tight` is a punchline — use it on the clicks/types that ARE the feature. `follow` is the cause-and-effect bridge. A good rhythm for a 4-step pin-a-task demo: tight (click pin) → follow (the row rises) → wide (settle on the new layout) → wide (final state). Don't make every step tight — it's exhausting and the viewer loses orientation.",
    "",
    "Step kinds:",
    "- `click` — click a button / link / item. label + (optional) role + camera.",
    "- `type` — focus an input, type into it. label + value + camera.",
    "- `press` — keyboard key (Enter, Escape, Tab, ArrowDown). key + camera.",
    "- `select` — pick an option from a <select>. label + value + camera.",
    "- `wait` — pause so a state is visible. ms (default 1500) + camera. REQUIRED at end of demo.",
    "- `navigate` — page change MID-DEMO when crossing a top-level surface. url. Avoid unless necessary; pass 2 starts on the app's start URL already.",
    "",
    "Think of yourself as crafting a 10-second clip your CEO will watch. Less is more. The goal is CLARITY, not coverage.",
  ].join("\n");
}

/**
 * METICULOUS prompt. Used when `--meticulous` / `TIK_METICULOUS=1` is set.
 * Same shape as the fast prompt but with a roomier budget (100 turns) and
 * the full freeze-the-moment recipe shelf for sub-second transitions —
 * intended for high-stakes PRs where a thorough automated check matters
 * more than a tight recording.
 */
function buildMeticulousSystemPrompt(): string {
  return [
    "You have ONE job: figure out — thoroughly — whether the feature works, and then write the IDEAL demo of it for a viewer. The recording from this validation pass is NOT shown to anyone. A second pass replays your STEPS deterministically; THAT is what gets shipped.",
    "",
    "Stop pretending to be a user. You are an automated tester with full DOM access. Use whatever is fastest:",
    "- Direct DOM probes via browser_evaluate (querySelector, getComputedStyle, dataset, ARIA attributes).",
    "- fetch() against the app's own endpoints from inside browser_evaluate.",
    "- localStorage / sessionStorage / IndexedDB reads.",
    "- Setting `.value`, dispatching events, calling `.click()` on hidden controls — bypassing the UI is FINE here.",
    "- Time-travel buffer (`__tikHistory`) for anything ephemeral.",
    "- Multiple tabs / new pages / different URLs when the feature lives on a surface other than the start page.",
    "",
    `BUDGET: AT MOST ${MAX_TURNS_METICULOUS} turns. Generous, so use the headroom on edge-case probes — but don't loop. Bundle independent probes in ONE assistant turn (multiple tool_use blocks in parallel). Each independent assertion you can make in one round-trip is one round-trip saved.`,
    "",
    "VERIFICATION HIERARCHY — pick the FASTEST tier that gives confidence. You do NOT have to walk it top-down:",
    "  • Programmatic — querySelector / fetch / evaluate. Often the FASTEST when the feature is data-driven (count updated, record saved, class toggled, attr flipped). OUTCOME starts with 'verified programmatically:' and names the DOM/network signal.",
    "  • Time-travel — `await __tikHistory.find({ text, sinceMs: 30000 })` for state that already happened but isn't on screen now (chat replies, toasts, spinners, banners, transient items). OUTCOME starts with 'verified programmatically (time-travel):'.",
    "  • Freeze + screenshot — `await __tikFreeze.pause()` then screenshot then `__tikFreeze.resume()` — for sub-second visual transitions you need to SEE pixels of.",
    "  • UI screenshot — when the feature is purely visual (a layout, a colour change, a new element rendered). Take ONE.",
    "  • Skipped — `OUTCOME: skipped — needs human verification: <reason>` only when no automated path can give a clean answer. Does NOT mark the PR check red.",
    "",
    "MISSING-CONTENT PROTOCOL — when a snapshot/screenshot doesn't show what you expected, your IMMEDIATELY NEXT tool call is `__tikHistory.find({ text: '<expected>', sinceMs: 30000 })`. Not a retry. Not another screenshot. The buffer disambiguates ephemeral-vs-never. Cite `sinceNowMs` in your OUTCOME if it hits.",
    "",
    "STUCK-LOOP TRIPWIRE — same tool with same input twice and the page hasn't moved? STOP. Try ONE different verification path (different tier). If that also fails, OUTCOME: skipped. Looping wastes budget and tells you nothing.",
    "",
    "Time-travel buffer (the tools `__tikHistory` exposes via browser_evaluate):",
    "  • `__tikHistory.find({ text, tag, testid, containerTestid, kind, sinceMs })` — filtered list. `kind` ∈ {'added', 'removed', 'text-changed', 'attr-changed'}. Each entry: `{ ts, sinceNowMs, tag, testid, containerTestid, ariaLabel, role, text, bbox, kind }`.",
    "  • `__tikHistory.transients(sinceMs)` — elements that appeared then disappeared (`addedAt`, `removedAt`, `durationMs`).",
    "  • `__tikHistory.stats()` — buffer state.",
    "  • `__tikFreeze.pause()` / `__tikFreeze.resume()` — pause / resume CSS animations + Web Animations API. Manual variants: `document.getAnimations().forEach(a => a.pause())`, `window.requestAnimationFrame = () => 0`, monkey-patching setTimeout.",
    "",
    "Context:",
    "- Browser is ALREADY on the app's start URL. Login already happened in a separate phase if your tiktest.md declared credentials.",
    "- REVIEWER NOTES in the user message are AUTHORITATIVE — follow them first.",
    "- Don't force a precondition that isn't there. If the goal needs a 'first-visit' state but the app shows prior-session data, emit `OUTCOME: failure — precondition not satisfied — <what was wrong>`. Test-environment state pollution is the correct outcome to report.",
    "",
    "Every goal ends with THREE blocks: OUTCOME, SHORTNOTE, STEPS.",
    "",
    "OUTCOME: success — full reason (≤30 words). Cite the specific signal you saw.",
    "SHORTNOTE: 5-9 word headline for the on-video checklist.",
    "",
    "OUTCOME: failure — full reason (expected vs actual).",
    "SHORTNOTE: 5-9 words naming WHAT broke.",
    "",
    "OUTCOME: skipped — needs human verification: <reason>.",
    "SHORTNOTE: 5-9 words naming WHY it can't be auto-tested.",
    "",
    "STEPS — DESIGN THE PERFECT DEMO (required on success and failure):",
    "",
    "STEPS is your CREATIVE BRIEF for a 8-15 second demo that makes this feature crystal-clear to a viewer who has never seen the app. Pass 2 will replay these deterministically — slow, deliberate, narrated — so design for CLARITY not coverage.",
    "",
    "Format:",
    "STEPS:",
    "```json",
    "[",
    "  { \"kind\": \"click\",  \"label\": \"<visible button text>\",      \"role\": \"button\",   \"camera\": \"tight\", \"hint\": \"open the form\" },",
    "  { \"kind\": \"type\",   \"label\": \"<input label / placeholder>\", \"value\": \"<text>\",  \"camera\": \"tight\", \"hint\": \"name the new item\" },",
    "  { \"kind\": \"press\",  \"key\":   \"Enter\",                          \"camera\": \"follow\", \"hint\": \"submit\" },",
    "  { \"kind\": \"wait\",   \"ms\":    1500,                              \"camera\": \"wide\",   \"hint\": \"the result appears\" }",
    "]",
    "```",
    "",
    "Rules of good demo design (same as the fast prompt — pass 2 has identical playback semantics):",
    "- 3 to 7 steps. Fewer is better.",
    "- Every step does something the viewer can VISUALLY observe — no probes, no DOM hacks. Real clicks/typing only.",
    "- ALWAYS end with a `wait` step so the result of the last action sits on screen with the narrator describing it.",
    "- Use `hint` on every step. One short generic phrase the narrator works from. NOT product-specific.",
    "- Pick the SIMPLEST happy path even if you tested edge cases. The demo is for a viewer learning the feature; edge cases belong in the next goal.",
    "- Labels MUST be the user-visible text on screen. NO CSS selectors, NO Playwright refs. Pass 2 resolves via getByRole / getByLabel / getByText against a FRESH browser.",
    "- For `click`/`select`, include `role` when the label is short or generic.",
    "",
    "Camera direction (`camera` field — replaces ad-hoc reactive zoom; you direct it):",
    "- `tight`: zoom in on the action point. Use when ONE specific control is the subject — a button, an input, a toggle.",
    "- `wide`: full-page view. Default. Use for context shots and moments where the result spans the page.",
    "- `follow`: start tight, ease out to wide over the step's duration. Use when the action triggers a visible effect ELSEWHERE on the page (toast in the corner, list update at the top).",
    "- Most steps should be `wide`. `tight` is a punchline. `follow` is the cause-and-effect bridge. Don't make every step tight — the viewer loses orientation.",
    "",
    "Step kinds: click, type, press, select, wait, navigate. Wait at end of demo is required.",
    "",
    "Think of yourself as crafting a 10-second clip your CEO will watch. Less is more.",
  ].join("\n");
}

function buildUserMessage(goal: Goal, prContext: string): string {
  const parts: string[] = [
    `GOAL: ${goal.intent}`,
    `SUCCESS CONDITION: ${goal.success || "(inferred from goal)"}`,
  ];
  if (prContext.trim()) parts.push("", "CONTEXT:", prContext.trim());
  parts.push("", "Achieve the goal. End with the OUTCOME line.");
  return parts.join("\n");
}

function extractOutcome(text: string): { outcome: "success" | "failure" | "skipped"; note: string; shortNote?: string; steps?: DemoStep[] } | null {
  // OUTCOME: <success|failure|skipped> — <note>     (single-line; up to next line break)
  const om = /OUTCOME:\s*(success|failure|skipped)\s*[—\-:]\s*([^\n\r]+)/i.exec(text);
  if (!om) return null;
  // SHORTNOTE: <5-9 word headline>          (optional; agent may forget)
  const sm = /SHORTNOTE:\s*([^\n\r]+)/i.exec(text);
  const shortNote = sm ? sm[1].trim().slice(0, 80) : undefined;
  return {
    outcome: om[1].toLowerCase() as "success" | "failure" | "skipped",
    note: om[2].trim().slice(0, 200),
    shortNote,
    steps: extractSteps(text),
  };
}

/** Pull the choreographed demo step list the agent emits at the end of
 *  a goal. The agent is asked to emit it inside a fenced JSON block tagged
 *  `STEPS`, e.g.:
 *
 *      STEPS:
 *      ```json
 *      [
 *        { "kind": "click", "label": "Add task", "role": "button" },
 *        { "kind": "type",  "label": "Title",    "value": "Buy milk" },
 *        { "kind": "press", "key": "Enter",      "hint": "submit the form" }
 *      ]
 *      ```
 *
 *  Best-effort: if parsing fails or no block is present, return undefined
 *  and pass 2 falls back to pass-1 video for this goal. */
function extractSteps(text: string): DemoStep[] | undefined {
  // Look for STEPS: followed by a fenced JSON block. Permissive on whitespace
  // and on the `json` tag (some agent runs forget it).
  const m = /STEPS:\s*```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (!m) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: DemoStep[] = [];
  const allowedKinds = new Set(["click", "type", "press", "select", "wait", "navigate"]);
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === "string" ? r.kind.toLowerCase() : null;
    if (!kind || !allowedKinds.has(kind)) continue;
    const step: DemoStep = { kind: kind as DemoStep["kind"] };
    if (typeof r.label === "string") step.label = r.label.slice(0, 120);
    if (typeof r.role === "string") step.role = r.role.slice(0, 32);
    if (typeof r.value === "string") step.value = r.value.slice(0, 400);
    if (typeof r.key === "string") step.key = r.key.slice(0, 32);
    if (typeof r.ms === "number" && r.ms >= 0) step.ms = Math.min(10000, Math.round(r.ms));
    if (typeof r.url === "string") step.url = r.url.slice(0, 500);
    if (typeof r.hint === "string") step.hint = r.hint.slice(0, 240);
    out.push(step);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Drive the browser toward one goal. Spawns `claude` CLI with Playwright
 * MCP attached over stream-json, reads tool_use events for our log,
 * extracts the final OUTCOME line from the assistant's text output.
 */
export async function runGoal(
  page: Page,
  goal: Goal,
  prContext: string,
  cdpEndpoint: string,
): Promise<GoalResult> {
  const history: GoalResult["actions"] = [];
  let outcome: "success" | "failure" | "skipped" = "failure";
  let note: string | undefined = "agent did not emit OUTCOME";
  let shortNote: string | undefined;
  let steps: DemoStep[] | undefined;

  // Write MCP config to a temp file; the CLI accepts an inline JSON string
  // via --mcp-config but putting it in a file keeps the command line clean
  // and avoids shell quoting drama with the CDP URL.
  const dir = await mkdtemp(path.join(tmpdir(), "tiktest-mcp-"));
  const mcpConfigPath = path.join(dir, "mcp.json");
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", cdpEndpoint, "--image-responses", "omit"],
        },
      },
    }, null, 2),
  );

  const meticulous = isMeticulous();
  const systemPrompt = meticulous ? buildMeticulousSystemPrompt() : buildFastSystemPrompt();
  const maxTurns = meticulous ? MAX_TURNS_METICULOUS : MAX_TURNS_DEFAULT;
  const userMessage = buildUserMessage(goal, prContext);

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--system-prompt", systemPrompt,
    "--mcp-config", mcpConfigPath,
    "--allowed-tools", "mcp__playwright",
    // Block built-in shell + filesystem tools. Under bypassPermissions the
    // allowedTools flag is additive, not exclusive, so Bash and Read stay
    // available by default — agents would spawn shells when confused,
    // dragging out per-goal runtime. The agent's job is to drive a browser;
    // it has no reason to read files or shell out.
    "--disallowed-tools", "Bash,Read",
    "--max-turns", String(maxTurns),
    "--permission-mode", "bypassPermissions",
    // User requested Opus — prefer thinking quality over raw speed. Sonnet
    // sometimes made snap decisions based on partial evidence.
    "--model", "opus",
  ];

  return await new Promise<GoalResult>((resolve) => {
    // Spawn from /tmp so the CLI doesn't auto-discover tik-test's own
    // CLAUDE.md — that file lists the dogfood URL (localhost:4173) and
    // the agent would pick it up and navigate to the wrong app. We still
    // want the CLI's own auth (OAuth/subscription) so we don't use
    // --bare (which would force ANTHROPIC_API_KEY).
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: "/tmp" });
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ outcome: "failure", note: `agent timeout after ${CLAUDE_TIMEOUT_MS}ms`, actions: history });
    }, CLAUDE_TIMEOUT_MS);

    // Map tool_use_id → index in `history` so we can attach tool_result
    // content back to the action that produced it. Stream-json emits the
    // assistant's tool_use first, then a user-role message containing the
    // tool_result block later (async, after MCP returns).
    const toolUseToHistoryIdx = new Map<string, number>();
    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "assistant" && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === "tool_use") {
                const name = String(block.name || "").replace(/^mcp__playwright__/, "");
                const input = block.input ?? {};
                // Prefer the HUMAN-READABLE description (`element`) so downstream
                // narration can say "clicked Sign In" instead of "clicked ref=e123".
                // Fall back to selector / url / ref only when no description exists.
                const target = input.element || input.url || input.selector || input.ref || "";
                const value = input.text ?? input.key ?? input.function ?? "";
                const idx = history.length;
                history.push({
                  kind: name,
                  target: String(target).slice(0, 120),
                  value: String(value).slice(0, 400),
                  ok: true,
                  startedAt: Date.now(),
                });
                if (block.id) toolUseToHistoryIdx.set(block.id, idx);
                const detail = [target, value].filter(Boolean).join(" ").slice(0, 80);
                console.log(chalk.dim(`     ${chalk.green("◦")} ${name}${detail ? " " + detail : ""}`));
              } else if (block.type === "text" && typeof block.text === "string") {
                const parsed = extractOutcome(block.text);
                if (parsed) {
                  outcome = parsed.outcome;
                  note = parsed.note;
                  shortNote = parsed.shortNote;
                  if (parsed.steps) steps = parsed.steps;
                  // Agent has concluded — kill the CLI now instead of waiting
                  // for it to finish its next assistant-only turn. Every
                  // second we let it linger is a second of dead video.
                  try { child.kill("SIGTERM"); } catch {}
                }
              }
            }
          } else if (ev.type === "user" && ev.message?.content) {
            // Capture tool_result blocks — the data an agent just learned
            // (e.g. JS eval output, network request list). Stored back on
            // the originating action entry so the editor can overlay it.
            for (const block of ev.message.content) {
              if (block.type === "tool_result") {
                const idx = toolUseToHistoryIdx.get(block.tool_use_id);
                if (idx === undefined) continue;
                const content = block.content;
                let text = "";
                if (typeof content === "string") text = content;
                else if (Array.isArray(content)) {
                  for (const c of content) {
                    if (c?.type === "text" && typeof c.text === "string") text += c.text + "\n";
                  }
                }
                history[idx].result = text.trim().slice(0, 600);
                if (block.is_error) history[idx].ok = false;
              }
            }
          } else if (ev.type === "result") {
            // final result event — loop will close naturally
          }
        } catch {
          // ignore parse errors — some lines are debug noise
        }
      }
    });
    child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ outcome: "failure", note: `spawn error: ${e.message.slice(0, 120)}`, actions: history });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (stderrBuf && history.length === 0) {
        note = `claude CLI stderr: ${stderrBuf.split("\n")[0].slice(0, 140)}`;
      }
      resolve({ outcome, note, shortNote, actions: history, steps });
    });

    // Send the user message as a single stream-json user event.
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text: userMessage }] } };
    child.stdin.write(JSON.stringify(msg) + "\n");
    child.stdin.end();
  });
}
