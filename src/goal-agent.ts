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

export interface GoalResult {
  outcome: "success" | "failure";
  note?: string;
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
// Very generous safety ceiling — only to catch truly stuck sessions. Agent
// can take multiple minutes inspecting if the goal requires it. The final
// video is what matters and that's editor responsibility.
const CLAUDE_TIMEOUT_MS = 600_000;

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
    "",
    "Tool use:",
    "- browser_snapshot to read the page (accessibility tree with refs).",
    "- browser_click / browser_type / browser_press / browser_scroll_* for user-like interactions.",
    "- browser_evaluate and browser_network_requests: use at most ONCE each when the goal explicitly requires data the snapshot doesn't show. One shot that returns everything. Don't iterate.",
    "- browser_take_screenshot: rare, only for clearly visual checks.",
    "",
    "Context:",
    "- The browser is ALREADY on the app and logged in. Don't navigate to localhost. Start with browser_snapshot.",
    "- REVIEWER NOTES in the user message are AUTHORITATIVE — a reviewer has already tested this PR and is telling you the happy path. Follow their instructions first.",
    "",
    "When the user would know the feature works (or doesn't), you're done. Emit OUTCOME, stop.",
    "",
    "Every goal ends with ONE line, exactly:",
    "OUTCOME: success — short reason",
    "OUTCOME: failure — short reason",
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

function extractOutcome(text: string): { outcome: "success" | "failure"; note: string } | null {
  const m = /OUTCOME:\s*(success|failure)\s*[—\-:]\s*(.+)/i.exec(text);
  if (!m) return null;
  return { outcome: m[1].toLowerCase() as "success" | "failure", note: m[2].trim().slice(0, 200) };
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
      resolve({ outcome, note, actions: history });
    });

    // Send the user message as a single stream-json user event.
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text: userMessage }] } };
    child.stdin.write(JSON.stringify(msg) + "\n");
    child.stdin.end();
  });
}
