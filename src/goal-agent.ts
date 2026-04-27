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
  outcome: "success" | "failure";
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

// Generous safety ceilings — not budgets the agent works inside. The agent
// should test as fast and thoroughly as possible; the editor trims the raw
// video down to the highlight reel. These only catch runaway sessions.
const MAX_TURNS_PER_GOAL = 80;
// Per-goal CLI runtime ceiling. Configurable via TIK_AGENT_TIMEOUT_MS env
// (or `agent-timeout` action input). Default 10 min. See src/timeouts.ts.
const CLAUDE_TIMEOUT_MS = AGENT_TIMEOUT_MS;

function buildSystemPrompt(): string {
  return [
    "You are driving a web browser to TEST AND DEMO a feature. Think: PM recording a 60-second video walkthrough — not a debugger, not an engineer inspecting internals.",
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
    "Tool use:",
    "- browser_snapshot to read the page structure (accessibility tree with refs). Good for finding clickable elements; NOT proof of what's visible. The snapshot includes elements that are CSS-hidden, behind a fixed header, off-screen, or clipped — they all show up in the tree as if they were visible.",
    "- browser_click / browser_type / browser_press / browser_hover / browser_scroll_* for user-like interactions.",
    "- browser_take_screenshot: REQUIRED whenever a goal asks you to verify how something LOOKS, is SHOWN, is VISIBLE, is HIDDEN, or any other visual property. The accessibility tree is not enough — an element can be in the DOM and still be invisible to a real user (clipped behind a fixed header, scrolled off-screen, hidden by `opacity-0`, cropped out by the video aspect ratio, etc.). If the success criterion contains words like 'shows', 'displays', 'visible', 'appears', 'highlighted', 'colour/color', 'overlay', 'cropped', 'cut off', 'positioned', take a screenshot. Treat the screenshot, not the snapshot, as ground truth for visual claims.",
    "- browser_evaluate: prefer the UI. Use this only when the UI genuinely can't reach the state the goal needs — e.g. resetting localStorage/sessionStorage so a 'first-time visitor' goal can be tested, reading a value the rendered page doesn't expose. HARD CAP: 5 calls per goal — count them as you go and stop at 5 even if you'd like a sixth. Each one should answer the question 'why couldn't I do this through the UI?'. If the answer is 'I could, but it'd be faster this way', don't. NEVER use it to inject form values, set <input type=date>, click hidden elements, or otherwise bypass user interactions you'd be testing.",
    "  Storage reset gotcha: clearing localStorage/sessionStorage does NOT reset in-memory app state. React/Vue/Svelte components that read storage on mount keep the cached value in memory afterwards. To get a real 'first visit' state, do storage clear + page reload (browser_navigate to the same URL works), then check the screen IMMEDIATELY before any auto-advance / dwell timer / animation can fire. If that ordering still can't produce the precondition, that's a 'precondition not satisfiable' failure — emit it and move on, don't keep clearing.",
    "- browser_network_requests: at most once, only if the goal's success condition mentions network behaviour.",
    "",
    "USE THE UI LIKE A REAL USER:",
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
    "OUTCOME: success — full reason (up to 30 words, the PR comment uses this verbatim)",
    "SHORTNOTE: 5-9 word headline for the on-video checklist — ≤60 chars, scannable in 1s",
    "",
    "On failure use the same shape:",
    "OUTCOME: failure — full reason (state expected vs actual, plain language, no jargon)",
    "SHORTNOTE: 5-9 words naming WHAT broke (e.g. \"today filter empty despite today badge\")",
    "",
    "Visual claims must cite the screenshot. If your OUTCOME describes anything visual — colour, position, visibility, what's shown vs hidden, what's overlaid — the reason must reference what the screenshot ACTUALLY rendered, not what the snapshot text says. Bad: 'OUTCOME: success — element shows correct label'. Good: 'OUTCOME: success — screenshot shows blue button at top-right of toolbar with 'Save' label'. Bad: 'OUTCOME: success — element is visible'. Good: 'OUTCOME: failure — screenshot shows element clipped behind the fixed top header'. If you didn't take a screenshot for a visual goal, take one before emitting OUTCOME.",
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

function extractOutcome(text: string): { outcome: "success" | "failure"; note: string; shortNote?: string } | null {
  // OUTCOME: <success|failure> — <note>     (single-line; up to next line break)
  const om = /OUTCOME:\s*(success|failure)\s*[—\-:]\s*([^\n\r]+)/i.exec(text);
  if (!om) return null;
  // SHORTNOTE: <5-9 word headline>          (optional; agent may forget)
  const sm = /SHORTNOTE:\s*([^\n\r]+)/i.exec(text);
  const shortNote = sm ? sm[1].trim().slice(0, 80) : undefined;
  return {
    outcome: om[1].toLowerCase() as "success" | "failure",
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
  let outcome: "success" | "failure" = "failure";
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

  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(goal, prContext);

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--system-prompt", systemPrompt,
    "--mcp-config", mcpConfigPath,
    "--allowed-tools", "mcp__playwright",
    "--max-turns", String(MAX_TURNS_PER_GOAL),
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
