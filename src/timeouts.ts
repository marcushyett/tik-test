/**
 * Centralised, env-overridable knobs that shape EVERY part of the run:
 *   - Five `claude` CLI timeouts (plan, agent, narration, setup, feature-finder)
 *   - Body-narration scene density (min chunk length, max scene count)
 *   - Outro checklist sizing (min/max items)
 *   - Intro / outro card durations + outro post-voice hold
 *
 * Defaults are tuned for a typical PR (1-3 goals, 30-60s of recording,
 * 8-12 narration scenes, 6-10 checklist items) on the Claude Max
 * subscription. Each value is overridable via the matching env var below
 * — and the GitHub Action surfaces the most useful ones as typed inputs.
 *
 * Filename is `timeouts.ts` for backwards-import-compat — file now also
 * houses the scene/checklist knobs since they live in the same "policy"
 * layer of the codebase.
 */

function envInt(key: string, fallback: number, kind: "ms" | "items" | "seconds"): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`tik-test: ignoring invalid ${key}="${raw}" (expected positive integer ${kind}), using default ${fallback}`);
    return fallback;
  }
  return n;
}
function envFloat(key: string, fallback: number, kind: string): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`tik-test: ignoring invalid ${key}="${raw}" (expected positive ${kind}), using default ${fallback}`);
    return fallback;
  }
  return n;
}

// ── Timeouts ─────────────────────────────────────────────────────────────

/** Plan generation: ONE Claude call that produces 1-3 goals. Default 4 min. */
export const PLAN_TIMEOUT_MS = envInt("TIK_PLAN_TIMEOUT_MS", 240_000, "ms");

/** Per-goal agent runtime: the agent drives the browser via Playwright MCP
 *  until it emits OUTCOME. A goal hitting this ceiling is a stuck/looping
 *  agent — bump only if your app legitimately needs >10 min per goal.
 *  Default 10 min. */
export const AGENT_TIMEOUT_MS = envInt("TIK_AGENT_TIMEOUT_MS", 600_000, "ms");

/** Narration generation: ONE Claude call that produces intro + outro +
 *  per-scene voice lines for the whole video. Default 9 min. */
export const NARRATION_TIMEOUT_MS = envInt("TIK_NARRATION_TIMEOUT_MS", 540_000, "ms");

/** Setup-step suggester. Default 60s. */
export const SETUP_TIMEOUT_MS = envInt("TIK_SETUP_TIMEOUT_MS", 60_000, "ms");

/** Feature finder. Default 60s. */
export const FEATURE_FINDER_TIMEOUT_MS = envInt("TIK_FEATURE_FINDER_TIMEOUT_MS", 60_000, "ms");

// ── Body narration density ────────────────────────────────────────────────

/** Minimum body chunk duration in seconds — shorter consecutive moments
 *  coalesce into the previous chunk. Larger value = fewer scenes = faster
 *  narration call (avoids sonnet timeouts on very long runs). Smaller =
 *  more granular narration but more risk of timeout. Default 3.5s. */
export const MIN_CHUNK_S = envFloat("TIK_MIN_CHUNK_S", 3.5, "seconds");

/** Hard ceiling on body scenes after coalescing. Above this we sample
 *  evenly so the prompt stays bounded. Bumping past 14 risks the
 *  narration-generation Claude call timing out on a 25+ tool run. */
export const MAX_BODY_SCENES = envInt("TIK_MAX_BODY_SCENES", 12, "items");

// ── Outro checklist ───────────────────────────────────────────────────────

/** Minimum checklist items the LLM should produce — below this we treat
 *  the call as failed and fall back to one row per goal. */
export const CHECKLIST_MIN_ITEMS = envInt("TIK_CHECKLIST_MIN_ITEMS", 4, "items");

/** Maximum checklist items rendered. Set higher and the dense layout
 *  shrinks rows; rows still must fit inside the 9:16 safe band. Default
 *  10 — empirically the largest count that stays scannable. */
export const CHECKLIST_MAX_ITEMS = envInt("TIK_CHECKLIST_MAX_ITEMS", 10, "items");

// ── Intro / outro durations ───────────────────────────────────────────────

/** Target intro narration window in seconds. Used to size the title-card
 *  Sequence and as the speak-time guidance to Claude. Default 4.5s. */
export const INTRO_TARGET_S = envFloat("TIK_INTRO_TARGET_S", 4.5, "seconds");

/** Target outro narration window in seconds. Default 4.0s. */
export const OUTRO_TARGET_S = envFloat("TIK_OUTRO_TARGET_S", 4.0, "seconds");

/** Extra seconds the outro Sequence holds AFTER the voice ends — the
 *  checklist sits readable on the last frame for this long. Bump if your
 *  reviewers want longer to read the list before auto-advancing.
 *  Default 3.5s. */
export const OUTRO_HOLD_S = envFloat("TIK_OUTRO_HOLD_S", 3.5, "seconds");
