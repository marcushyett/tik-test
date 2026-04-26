/**
 * Centralised, env-overridable timeouts for every Claude CLI call we make.
 *
 * Defaults are tuned for a typical PR (1–3 goals, 30–60s of recording,
 * 8–12 narration scenes) on the Claude Max subscription. Bump them when:
 *   - your repo's preview takes a long time to load (boosts agent time)
 *   - your PRs touch many surfaces and the agent ends up driving 50+
 *     tool calls per goal (boosts agent time + narration time)
 *   - you're hitting "claude CLI timed out after Xms" in the action logs
 *     even after the run otherwise looks healthy
 *
 * Each value can be overridden by setting the matching env var to a
 * positive integer of milliseconds — this is what the action.yml inputs
 * `plan-timeout`, `agent-timeout`, `narration-timeout` (etc.) do under
 * the hood.
 */

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`tik-test: ignoring invalid ${key}="${raw}" (expected positive integer milliseconds), using default ${fallback}ms`);
    return fallback;
  }
  return n;
}

/** Plan generation: ONE Claude call that produces 1–3 goals. Default 4 min. */
export const PLAN_TIMEOUT_MS = envMs("TIK_PLAN_TIMEOUT_MS", 240_000);

/** Per-goal agent runtime: the agent drives the browser via Playwright MCP
 *  until it emits OUTCOME. A goal hitting this ceiling is a stuck/looping
 *  agent — bump only if your app legitimately needs >10 min per goal.
 *  Default 10 min. */
export const AGENT_TIMEOUT_MS = envMs("TIK_AGENT_TIMEOUT_MS", 600_000);

/** Narration generation: ONE Claude call that produces intro + outro +
 *  per-scene voice lines for the whole video. Default 9 min. */
export const NARRATION_TIMEOUT_MS = envMs("TIK_NARRATION_TIMEOUT_MS", 540_000);

/** Setup-step suggester: ONE small Claude call to convert the README's
 *  TikTest section into a script. Default 60s. */
export const SETUP_TIMEOUT_MS = envMs("TIK_SETUP_TIMEOUT_MS", 60_000);

/** Feature finder: ONE small Claude call that scans the diff for the
 *  surface to test. Default 60s. */
export const FEATURE_FINDER_TIMEOUT_MS = envMs("TIK_FEATURE_FINDER_TIMEOUT_MS", 60_000);
