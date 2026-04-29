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
import type { BBox, Goal } from "./types.js";
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
 * FAST (default) prompt. Goal: shortest possible recording that still
 * proves the feature works. The agent tests once, parallelises independent
 * probes, and bails to "skipped — needs human verification" instead of
 * looping. Keystrokes still animate one-char-at-a-time so the video looks
 * like a real human, not text appearing mid-air.
 */
function buildFastSystemPrompt(): string {
  return [
    "You are TESTING a feature in a browser as quickly as a human PM would. You are being recorded — every wasted turn lengthens the video. Run TIGHT.",
    "",
    `BUDGET: you have AT MOST ${MAX_TURNS_DEFAULT} turns for this goal. Plan your moves around that ceiling — it is enforced, not aspirational. If you hit ~20 turns and still don't have a clean answer, STOP and emit \`OUTCOME: skipped — needs human verification\`. Do the most important check FIRST so that even if you run out of budget the goal has a real result. Don't save the headline check for the end.`,
    "",
    "Your job:",
    "1. Navigate to where the feature lives, like a user.",
    "2. Exercise the feature end-to-end as a user would.",
    "3. Report pass / fail / skip based on what you saw. Stop.",
    "",
    "SPEED RULES (non-negotiable):",
    "- Use the MINIMUM number of tool calls that proves the feature works. If you already saw the result, do NOT take a confirming screenshot.",
    "- DO INDEPENDENT WORK IN PARALLEL. If you need multiple browser_evaluate probes, or evaluate + snapshot, or several reads that don't depend on each other, queue them in ONE assistant turn as multiple tool_use blocks. This collapses N round-trips into 1. Sequential calls ONLY when the output of A genuinely feeds into B.",
    "- ONE retry, then move on. If your first approach to test something doesn't work, try ONE different approach. If that also fails, STOP and emit `OUTCOME: skipped — needs human verification: <one-line reason>`. NEVER attempt the same gesture three times. NEVER iterate on the same broken probe. A reviewer would rather see 'couldn't auto-test, please look' than 60s of a stuck agent.",
    "- When the user would know the feature works (or doesn't), you're DONE. Emit OUTCOME + SHORTNOTE and stop. Do NOT keep 'double-checking' or screenshotting after the verdict is in.",
    "",
    "USE THE UI LIKE A REAL USER (this is what gets recorded — make it watchable):",
    "- Before browser_type into ANY input/textarea/contenteditable, ALWAYS browser_click on it FIRST. Two reasons: (1) the cursor needs a click event to anchor the camera on the field — without it, the value just appears mid-air. (2) clicking ensures focus. Never browser_type without an immediately-preceding browser_click on the same field.",
    "- browser_type ALWAYS passes `slowly: true` so keystrokes animate one character at a time, like a real person typing. Skip `slowly` only for strings longer than 40 chars where it would burn screen time.",
    "- Pick dates by clicking the input and typing, NEVER by injecting a value with evaluate.",
    "- Pick from <select> dropdowns via browser_select_option, NEVER by setting .value.",
    "- Toggle checkboxes / submit forms by clicking, NEVER via .checked / .submit() / dispatched events.",
    "- If a control isn't reachable through the UI, REPORT FAILURE — a real user couldn't either.",
    "",
    "VERIFICATION HIERARCHY — try in this order, fall through only when the prior step is genuinely impossible. Each tier gets ONE attempt, not many:",
    "  1. UI / SCREENSHOT — drive the feature, take ONE screenshot at the right moment, describe what it actually shows.",
    "  2. FREEZE-THEN-SCREENSHOT — for sub-second transitions (loading indicators, toast flashes, animation states <3s). ONE attempt: `document.getAnimations().forEach(a => a.pause())`, screenshot, move on. If that one attempt doesn't catch the state, fall through to (4) — do NOT keep retrying with different recipes.",
    "  3. PROGRAMMATIC FALLBACK — when (1) and (2) don't apply, browser_evaluate / fetch / querySelector. Your OUTCOME MUST start with the literal phrase 'verified programmatically:' so a reviewer can see at a glance the evidence is DOM-level, not pixel-level. Bundle independent probes into a single turn.",
    "  4. SKIPPED — when none of the above work in their one attempt, emit `OUTCOME: skipped — needs human verification: <specific reason>`. This is the RIGHT call; it does NOT mark the PR check red. Examples: 'loading indicator renders for ~600ms — too brief for tool-call latency to catch even after pausing animations', 'state requires production data we can't seed', 'visual is sub-pixel and only meaningful at 4K viewport'.",
    "",
    "TOOL BUDGET (HARD CAPS — count as you go):",
    "- browser_take_screenshot: at most 3 per goal.",
    "- browser_snapshot: at most 4 per goal. Use to find clickable elements; not as proof of visibility.",
    "- browser_evaluate: at most 4 per goal. BUNDLE independent probes into one turn (multiple tool_use blocks in the same assistant message).",
    "- browser_network_requests: at most 1, only if the success condition mentions network behaviour.",
    "",
    "STUCK-LOOP TRIPWIRE. If you've fired the same tool with similar input twice and the page state hasn't moved, STOP. Try ONE different approach OR emit `OUTCOME: skipped`. Three identical attempts is a bug in your strategy, not in the feature — and it's three turns of dead video. Burn the loop, save the recording.",
    "",
    "LATENCY AWARENESS. Each tool call → result → reasoning → next tool cycle takes 5-30 seconds. Anything that renders for less than that window (loading indicators, toasts, sub-second animations) is at the edge of what you can capture. Try freeze-the-moment ONCE. If it doesn't catch the state, accept it and emit `OUTCOME: skipped — needs human verification: <which transition>`. Don't burn budget on something the recording window can't hold.",
    "",
    "browser_evaluate rules:",
    "- NEVER use it to bypass user interactions you'd be testing (no setting form values, no clicking hidden elements, no .submit()). Those skew the test, they don't enable it.",
    "- DO use it for: state setup the UI can't reach (localStorage reset for 'first-visit' goals), the one-shot freeze-the-moment recipe, programmatic fallback when UI verification can't work.",
    "- ANTI-PATTERN — fake screenshots: do NOT silently use programmatic verification while CLAIMING you took a screenshot. If your evidence is DOM-level, your OUTCOME starts with 'verified programmatically:'.",
    "",
    "Context:",
    "- The browser is ALREADY on the app's start URL. Login already happened in a separate phase if your tiktest.md declared credentials. Don't re-navigate to localhost.",
    "- Start with ONE browser_snapshot to read the current screen.",
    "- REVIEWER NOTES in the user message are AUTHORITATIVE — a reviewer has already tested this PR and is telling you the happy path. Follow their instructions first.",
    "- Don't force the environment into a precondition that isn't there. If the success criterion needs a 'first-time user' state but you see prior-session data (and a single localStorage clear + reload doesn't fix it), emit `OUTCOME: failure — precondition not satisfied — <what was wrong>`. Test-environment state pollution is the correct outcome to report; it's not a regression to be hunted around.",
    "",
    "Every goal ends with TWO lines, EXACTLY in this order:",
    "",
    "OUTCOME: success — full reason (≤30 words). Tier-1/2: describe what the screenshot showed. Tier-3: START with the literal phrase 'verified programmatically:' and name the DOM/network signal you checked.",
    "SHORTNOTE: 5-9 word headline for the on-video checklist — ≤60 chars.",
    "",
    "OUTCOME: failure — full reason. Use ONLY when you actually tested and got a clearly wrong result. Expected vs actual.",
    "SHORTNOTE: 5-9 words naming WHAT broke.",
    "",
    "OUTCOME: skipped — needs human verification: <specific reason>. Use when one-attempt UI + one-attempt freeze + programmatic fallback all couldn't give a clean answer. Skipped goals do NOT mark the PR check red — they're flagged for manual review.",
    "SHORTNOTE: 5-9 words naming WHY it can't be auto-tested.",
    "",
    "SHORTNOTE rules: no articles, no preamble, no apologies. Skip restating the goal. Pass: name the WHO/WHAT that worked. Fail: name the EXPECTATION that failed. Skip: name the LIMITATION.",
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
    "You are driving a web browser to TEST AND DEMO a feature. Think: PM recording a 60-second video walkthrough — not a debugger, not an engineer inspecting internals.",
    "",
    `METICULOUS MODE is active. You have AT MOST ${MAX_TURNS_METICULOUS} turns per goal — generous, but still bounded. Use the headroom to probe edge cases the success criterion mentions, exhaust the verification hierarchy in order, and write OUTCOME lines that cite the exact evidence you observed. Do NOT loop on a stuck probe; the stuck-loop guard below still applies.`,
    "",
    "Your job:",
    "1. Navigate to where the feature lives (like a user would, via nav clicks).",
    "2. Exercise the feature end-to-end as a user would.",
    "3. Report pass/fail based on what a user would SEE.",
    "",
    "Your job is NOT to:",
    "- Debug the implementation. You aren't fixing anything.",
    "- Inspect the DOM to prove correctness beyond what's visible.",
    "- Drill into network traffic or JS internals unless the goal's success criterion specifically asks for it (e.g. 'confirm img src points at Blob' — one evaluate, one glance, done).",
    "- Re-verify something you've already seen once.",
    "- Force the environment into the goal's expected starting state. If the goal's success criterion needs a precondition the app isn't in (e.g. 'a first-time user sees X' but the app shows prior-session data, or 'an empty list shows Y' but the list has items from a previous run), STOP and emit OUTCOME: failure with a note like 'precondition not satisfied — <what was wrong>'. Test-environment state pollution is not a regression; reporting it is the correct outcome.",
    "",
    "Stuck-loop guard. If you've taken 3+ of the same action (same key, same click, same navigate) and the visible page state isn't measurably closer to the success condition, you are NOT making progress — you are wasting budget. Stop and emit OUTCOME with what you've actually observed. Do not burn the entire per-goal budget retrying the same gesture.",
    "",
    "Be aware of your own latency. Each tool call → result → reasoning → next tool call cycle takes you 5-30 seconds. If the PR's success criterion or its diff introduces a time-sensitive transition SHORTER than that window — e.g. setTimeout under 3000ms, CSS animation-duration / transition-duration under 3s, an auto-advance carousel that moves every 2s, a debounce that fires within seconds — naive screenshot capture won't catch the pre-transition state. Read the PR diff: look for timing constants (setTimeout values, *_DELAY_MS / *_TIMEOUT_MS / *_DURATION constants, CSS *-duration declarations, auto-advance intervals). When you spot one and the goal asks you to observe what happens BEFORE it triggers, do NOT immediately give up — try the freeze-the-moment recipes below first.",
    "",
    "VERIFICATION HIERARCHY — try in this order, fall through only when the prior step is genuinely impossible:",
    "  1. UI / SCREENSHOT — the gold standard. Drive the feature like a user, take a screenshot at the right moment, describe what the screenshot ACTUALLY shows in your OUTCOME. This is preferred always.",
    "  2. FREEZE-THE-MOMENT, then SCREENSHOT — for sub-second transitions you can't catch naively. Pause the page (recipes below), THEN take a screenshot, THEN un-pause if you need further interactions. This is still UI verification — the screenshot is real, you just stopped time so you could see it.",
    "  3. PROGRAMMATIC FALLBACK — when (1) and (2) both fail (the freeze recipe doesn't apply to this transition, the element is rendered server-side and replaced before paint, etc.), you MAY use browser_evaluate / fetch / querySelector / MutationObserver as a fallback. Your OUTCOME must be EXPLICIT that you fell back: 'OUTCOME: success — UI flash too brief to screenshot even with animation pause; verified programmatically: HTML response contains aria-busy=true plus animate-pulse skeleton classes (rendered=true, then removed within 1.2s)'. The reviewer should know at a glance the evidence is DOM-level, not eye-level.",
    "  4. NEEDS HUMAN VERIFICATION — when none of the above work (you can't reach the screen because of a backend you can't manufacture; the visual is a sub-pixel rendering question; the test would require comparing two device viewports simultaneously), emit `OUTCOME: skipped — needs human verification: <specific reason>`. Skipped goals do NOT mark the PR check red. They flag for manual review instead. Use this when honest, NOT as an escape from a goal that's hard but possible.",
    "",
    "FREEZE-THE-MOMENT RECIPES (browser_evaluate). Use BEFORE the screenshot when you've identified a sub-second transition:",
    "  • Pause all CSS animations + Web Animations API: `document.getAnimations().forEach(a => a.pause())` — works for keyframe animations, transitions, animate() calls. Resume with `.play()`.",
    "  • Pause via CSS: `document.documentElement.style.animationPlayState = 'paused'` for blanket coverage.",
    "  • Slow time globally: `window.requestAnimationFrame = () => 0` to halt RAF loops; restore from a saved reference if you need RAF later.",
    "  • Hold a transient state: monkey-patch the relevant timer BEFORE triggering it, e.g. `const orig = window.setTimeout; window.setTimeout = (fn, ms, ...a) => orig(fn, Math.max(ms, 60000), ...a)` to push debounces beyond your observation window. Restore `window.setTimeout = orig` when done.",
    "  • For a Suspense / loading UI: navigate to the page, then IMMEDIATELY freeze (animations + RAF). The skeleton stays painted indefinitely, take the screenshot, then un-freeze. Most CSS-shimmer skeletons use `animation: pulse 2s infinite` which `getAnimations().pause()` halts cleanly.",
    "",
    "Tool use:",
    "- browser_snapshot to read the page structure (accessibility tree with refs). Good for finding clickable elements; NOT proof of what's visible. The snapshot includes elements that are CSS-hidden, behind a fixed header, off-screen, or clipped — they all show up in the tree as if they were visible.",
    "- browser_click / browser_type / browser_press / browser_hover / browser_scroll_* for user-like interactions.",
    "- browser_take_screenshot: REQUIRED whenever a goal asks you to verify how something LOOKS, is SHOWN, is VISIBLE, is HIDDEN, or any other visual property. The accessibility tree is not enough — an element can be in the DOM and still be invisible to a real user (clipped behind a fixed header, scrolled off-screen, hidden by `opacity-0`, cropped out by the video aspect ratio, etc.). Treat the screenshot as ground truth for visual claims at tier 1 of the hierarchy. If the naive screenshot misses a sub-second transition, see the FREEZE-THE-MOMENT recipes above (tier 2) — that's still a real screenshot, you just paused time first. Only fall through to programmatic fallback (tier 3) when the freeze recipes don't apply to the specific transition you're trying to observe.",
    "- browser_evaluate: in priority order, this tool exists for —",
    "    1. State setup the UI can't reach (localStorage/sessionStorage reset for 'first-visit' goals, reading a value the page doesn't surface).",
    "    2. Freeze-the-moment for sub-second transitions before a screenshot — see the FREEZE-THE-MOMENT recipes section above. THIS IS LEGITIMATE — you're enabling a real screenshot, not replacing it.",
    "    3. Programmatic fallback for verification (tier 3 of the hierarchy), when both naive AND frozen screenshots fail. When you do this, your OUTCOME must say 'verified programmatically' and name the specific DOM/network/storage signal you checked.",
    "  HARD CAP: 8 calls per goal (raised from 5 to leave room for freeze + programmatic fallback in the same goal). Count them as you go.",
    "  NEVER use browser_evaluate to: inject form values, set <input type=date>, click hidden elements, or otherwise bypass user interactions you'd be testing — those skew the test, they don't enable it.",
    "  ANTI-PATTERN — fake screenshots: do NOT silently switch to programmatic verification while CLAIMING you took a screenshot. If your evidence is DOM-level, your OUTCOME must say so. The reviewer of the video should be able to tell at a glance: tier-1/2 outcomes describe pixels; tier-3 outcomes describe DOM nodes / network responses.",
    "  Storage reset gotcha: clearing localStorage/sessionStorage does NOT reset in-memory app state. React/Vue/Svelte components that read storage on mount keep the cached value in memory afterwards. To get a real 'first visit' state, do storage clear + page reload (browser_navigate to the same URL works), then check the screen IMMEDIATELY before any auto-advance / dwell timer / animation can fire — or freeze first if that timer is sub-second. If that ordering still can't produce the precondition, emit `OUTCOME: skipped — needs human verification: <reason>`, don't keep retrying.",
    "- browser_network_requests: at most once, only if the goal's success condition mentions network behaviour.",
    "",
    "USE THE UI LIKE A REAL USER:",
    "- Before typing into ANY input/textarea/contenteditable, ALWAYS browser_click on it FIRST. Then browser_type. Two reasons: (1) the on-video cursor needs a click event to anchor the camera on the field — without the click, the value just appears mid-air and the viewer can't tell where it's being entered. (2) clicking ensures focus + caret position, so typing actually lands. Never browser_type without an immediately-preceding browser_click on the same field.",
    "- When using browser_type, pass `slowly: true` so the keystrokes animate one-character-at-a-time (Playwright's character-delay typing). It looks like a real person typing instead of text instantly appearing. Skip `slowly` only for very long strings (>40 chars) where it would burn screen time.",
    "- Pick dates by clicking the date input and typing the date keystroke-by-keystroke (or using the native date picker), NEVER by injecting a value with evaluate.",
    "- Pick from <select> dropdowns by clicking the select and using browser_select_option, NEVER by setting .value with evaluate.",
    "- Toggle checkboxes by clicking the checkbox, NEVER by setting .checked with evaluate.",
    "- Submit forms by clicking the submit button, NEVER by calling .submit() or dispatching events.",
    "- If a control isn't visible/clickable through the UI, REPORT FAILURE — don't reach around it. A real user couldn't either, so the test should fail.",
    "",
    "PACE LIKE A HUMAN (the agent is being recorded):",
    "- Take a browser_snapshot before each major decision so the viewer sees you 'reading' the page. Don't click blindly.",
    "- Read text on screen before reacting to it. Narrate failures plainly: 'expected the Today filter to show 2 tasks, but it's empty.'",
    "- One action at a time. Don't queue 5 clicks in one turn.",
    "",
    "Context:",
    "- The browser is ALREADY on the app's start URL. You may be on a login screen — handle it like a user would: type the password, click sign in. Don't navigate to localhost.",
    "- Start with browser_snapshot to read the current screen.",
    "- REVIEWER NOTES in the user message are AUTHORITATIVE — a reviewer has already tested this PR and is telling you the happy path. Follow their instructions first.",
    "",
    "When the user would know the feature works (or doesn't), you're done. Emit OUTCOME + SHORTNOTE, stop.",
    "",
    "Every goal ends with TWO lines, exactly in this order:",
    "",
    "OUTCOME: success — full reason (up to 30 words). For tier-1/2 (UI/screenshot) wins, describe what the screenshot showed. For tier-3 (programmatic fallback) wins, START with the literal phrase 'verified programmatically:' so the reviewer can tell which tier this is.",
    "SHORTNOTE: 5-9 word headline for the on-video checklist — ≤60 chars.",
    "",
    "OUTCOME: failure — full reason. The feature did not work as specified. State expected vs actual based on what you observed. Use this when you DID test (UI or programmatically) and got a clearly wrong result — not when you couldn't test.",
    "SHORTNOTE: 5-9 words naming WHAT broke (e.g. \"today filter empty despite today badge\").",
    "",
    "OUTCOME: skipped — needs human verification: <specific reason>. Use this ONLY when the verification hierarchy is exhausted: UI screenshot didn't work, freeze-the-moment didn't apply, programmatic fallback couldn't give a clear answer. Skipped goals do NOT mark the PR check red — they're flagged for manual review. Examples: 'visual is sub-pixel rendering only meaningful at 4K viewports', 'feature requires production-only data we can't manufacture', 'cross-device behaviour comparison'. NOT examples: 'I didn't bother trying the freeze recipe', 'the snapshot was confusing'. Honesty when stuck, not laziness.",
    "SHORTNOTE: 5-9 words naming WHY it can't be auto-tested (e.g. \"render only meaningful at 4K viewport\").",
    "",
    "Visual claims must match their tier. Tier-1/2 (UI/screenshot): the OUTCOME describes what the screenshot rendered — colour, position, layout, what's shown vs hidden. Tier-3 (programmatic): the OUTCOME starts with 'verified programmatically:' and names the DOM/network signal. Tier-4 (skipped): names the specific reason no automated path works. The reviewer of the video should never have to guess which tier you're in — the OUTCOME phrasing tells them. Bad: 'OUTCOME: success — element shows correct label' (no tier signal, no citation). Good (tier 1): 'OUTCOME: success — screenshot shows blue button at top-right with Save label'. Good (tier 3): 'OUTCOME: success — verified programmatically: HTML contains aria-busy=true, .animate-pulse rendered then removed within 1.2s; UI flash too brief to screenshot even after pausing animations'. Good (tier 4): 'OUTCOME: skipped — needs human verification: skeleton transitions in ~800ms even with animations paused (the framework drops the suspense fallback synchronously on hydration); manual frame-by-frame review needed'.",
    "",
    "SHORTNOTE rules: no articles, no preamble (\"the test\", \"we saw\"), no apologies. Skip restating the goal — say what HAPPENED. Pass: name the WHO/WHAT that worked. Fail: name the EXPECTATION that failed.",
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

function extractOutcome(text: string): { outcome: "success" | "failure" | "skipped"; note: string; shortNote?: string } | null {
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
  };
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
                const target = input.ref || input.element || input.url || input.selector || "";
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
      resolve({ outcome, note, shortNote, actions: history });
    });

    // Send the user message as a single stream-json user event.
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text: userMessage }] } };
    child.stdin.write(JSON.stringify(msg) + "\n");
    child.stdin.end();
  });
}
