/**
 * Shared `claude` CLI helpers used by every one-shot Claude call we make
 * (plan, narration, checklist, setup, feature-finder).
 *
 * Each caller used to ship its own near-identical `runClaude` (~25 lines)
 * differing only in: model flag, default timeout, error label, whether
 * to trim the output. That's ~125 lines of duplicated subprocess + timer
 * + stdout-capture plumbing for ZERO meaningful divergence. This module
 * is the one place to fix bugs in the spawn / signal / encoding plumbing.
 */
import { spawn } from "node:child_process";

export interface RunClaudeOptions {
  /** The prompt body — passed via `claude -p <prompt>`. */
  prompt: string;
  /** Hard kill after this many ms. Use a value from src/timeouts.ts. */
  timeoutMs: number;
  /** Optional model override. `undefined` uses the CLI default (opus). */
  model?: "sonnet" | "haiku" | "opus";
  /** Short label included in error messages so a stack trace tells us
   *  which call site failed without grepping. */
  label: string;
}

/**
 * Spawn `claude -p <prompt> --output-format text [--model <model>]` and
 * resolve with the trimmed stdout, or reject on non-zero exit / timeout
 * / spawn error. The returned string is whatever `claude` printed to
 * stdout — callers parse JSON / extract narration / etc. as needed.
 */
export function runClaude({ prompt, timeoutMs, model, label }: RunClaudeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "text"];
    if (model) args.push("--model", model);
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${label} claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${label} claude exited ${code}: ${err || out}`));
      resolve(out.trim());
    });
  });
}

/**
 * Extract a JSON document from a `claude` text response. Handles three
 * shapes Claude returns in practice:
 *   1. Raw `{...}` (what we ASKED for; usually arrives as-is).
 *   2. Fenced ```json ...``` blocks (model adds them despite "no markdown").
 *   3. JSON wrapped in surrounding prose (model explains itself first).
 *
 * Falls back to the trimmed input if no recognisable shape is found, so
 * the caller's `JSON.parse` produces a more useful error than ours.
 */
export function extractJson(text: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}
