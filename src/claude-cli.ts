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
import { getKnob, overrideHint } from "./timeouts.js";

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
  /** Env-var name of the timeout knob (e.g. `TIK_PLAN_TIMEOUT_MS`).
   *  When set, a timeout error includes "bump <env> or pass <action-input>"
   *  so the user knows EXACTLY what to change instead of grep-hunting. */
  timeoutKnob?: string;
}

/**
 * Spawn `claude -p <prompt> --output-format text [--model <model>]` and
 * resolve with the trimmed stdout, or reject on non-zero exit / timeout
 * / spawn error. The returned string is whatever `claude` printed to
 * stdout — callers parse JSON / extract narration / etc. as needed.
 */
export function runClaude({ prompt, timeoutMs, model, label, timeoutKnob }: RunClaudeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "text"];
    if (model) args.push("--model", model);
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      const knob = timeoutKnob ? getKnob(timeoutKnob) : undefined;
      const hint = knob ? ` — ${overrideHint(knob)} to raise the limit` : "";
      reject(new Error(`${label} claude timed out after ${timeoutMs}ms${hint}`));
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

/**
 * Spawn `claude` and parse the response as JSON, retrying on parse failure
 * with the bad output fed back in as feedback. Most LLM-JSON failures are
 * one-character mistakes (an unescaped `"` inside a `note`, a trailing
 * comma) that the model corrects immediately when shown its own broken
 * output. We burn the extra CLI call on the user's Claude budget — the
 * narrator/checklist/plan paths are unusable when the JSON is malformed,
 * so cost-of-second-call < cost-of-fallback-with-empty-data.
 *
 * Returns the PARSED value (typed by the caller) plus how many attempts
 * it took, so callers can log telemetry without having to wrap the call.
 */
export interface RunClaudeJsonOptions extends RunClaudeOptions {
  /** Total tries including the first. Default 3 — covers ~99% of LLM
   *  JSON wobbles in practice; beyond that the prompt itself is at fault. */
  maxAttempts?: number;
}

export interface RunClaudeJsonResult<T> {
  value: T;
  attempts: number;
  /** The raw text that successfully parsed. Useful for callers that want
   *  to surface the model's actual output in logs / telemetry. */
  rawJson: string;
}

export async function runClaudeJson<T = unknown>(
  opts: RunClaudeJsonOptions,
): Promise<RunClaudeJsonResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  let lastErr: Error | null = null;
  let lastBadOutput = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // On retry, frame the original prompt with the failure context. The
    // model sees its own broken output AND the parser's complaint, which
    // it self-corrects far more reliably than just a vague "try again".
    const prompt = attempt === 1
      ? opts.prompt
      : `${opts.prompt}\n\n---\n\nYOUR PREVIOUS RESPONSE WAS NOT VALID JSON.\nParser error: ${lastErr?.message ?? "unknown"}\n\nYour previous output (truncated to 1200 chars):\n${lastBadOutput.slice(0, 1200)}\n\nRe-emit ONLY the JSON document. No markdown fences, no prose, no commentary. Every string value must be properly escaped — backslash-escape any literal " inside a string. No trailing commas. The output must parse with JSON.parse on the first try.`;
    let raw: string;
    try {
      raw = await runClaude({ ...opts, prompt });
    } catch (e) {
      // Spawn / timeout / non-zero exit. Don't retry these — the JSON
      // repair feedback only helps when we got SOMETHING back.
      throw e;
    }
    const json = extractJson(raw);
    try {
      const value = JSON.parse(json) as T;
      return { value, attempts: attempt, rawJson: json };
    } catch (e) {
      lastErr = e as Error;
      lastBadOutput = raw;
      // Fall through to retry. If we've exhausted attempts, the loop
      // will exit and we throw below.
    }
  }
  throw new Error(`${opts.label}: claude returned unparseable JSON after ${maxAttempts} attempt(s) — last error: ${lastErr?.message ?? "unknown"}`);
}
