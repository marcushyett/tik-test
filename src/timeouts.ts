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
 * — and the GitHub Action surfaces every one as a typed input.
 *
 * The KNOBS table at the top is the SINGLE SOURCE OF TRUTH for what's
 * configurable. The exported constants below are derived from it; the
 * `tik-test config` subcommand reads it for display; action.yml inputs
 * mirror its `actionInput` field. Add a new knob in ONE place.
 *
 * Filename is `timeouts.ts` for backwards-import-compat — file now also
 * houses the scene/checklist knobs since they live in the same "policy"
 * layer of the codebase.
 */

export interface Knob {
  /** Env var name — `TIK_*`. */
  key: string;
  /** Matching GitHub Action input name (kebab-case). Omit if not exposed. */
  actionInput?: string;
  /** Default applied when the env var is unset/invalid. */
  default: number;
  /** Whether the value is integer-only (`int`) or accepts floats (`float`). */
  kind: "int" | "float";
  /** Display unit. Used in `tik-test config` output and error messages. */
  unit: "ms" | "seconds" | "items";
  /** One-line summary — what this knob caps. */
  description: string;
  /** What goes wrong if you set it lower than default. */
  riskLower: string;
  /** What goes wrong if you set it higher than default. */
  riskHigher: string;
}

/**
 * Source of truth. Order matters — `tik-test config` prints in this order,
 * so keep related knobs grouped (timeouts → scene density → checklist →
 * intro/outro).
 */
export const KNOBS: Knob[] = [
  // ── Claude CLI timeouts ──────────────────────────────────────────────
  {
    key: "TIK_PLAN_TIMEOUT_MS",
    actionInput: "plan-timeout",
    default: 240_000,
    kind: "int",
    unit: "ms",
    description: "One-shot plan-generation `claude` call (digests PR diff + claude.md, emits 1-3 goals).",
    riskLower: "small diffs may still take 60s+; too low and you time out before plan is even drafted",
    riskHigher: "wastes CI budget on hung Claude processes",
  },
  {
    key: "TIK_AGENT_TIMEOUT_MS",
    actionInput: "agent-timeout",
    default: 600_000,
    kind: "int",
    unit: "ms",
    description: "EACH per-goal browser-driving `claude` call. A goal hitting this ceiling is a stuck/looping agent.",
    riskLower: "real cold starts (Vercel preview waking up) can eat 90s alone — be generous",
    riskHigher: "hung agents drain the 25-min job budget; a wedged agent rarely recovers",
  },
  {
    key: "TIK_NARRATION_TIMEOUT_MS",
    actionInput: "narration-timeout",
    default: 540_000,
    kind: "int",
    unit: "ms",
    description: "ONE Claude call that produces intro + outro + every scene line for the whole video.",
    riskLower: "long runs (15+ scenes) regularly hit 6+ min; too low forces silent-fallback path",
    riskHigher: "doesn't help if Claude is wedged; trim scenes via TIK_MAX_BODY_SCENES instead",
  },
  {
    key: "TIK_FEATURE_FINDER_TIMEOUT_MS",
    actionInput: "feature-finder-timeout",
    default: 60_000,
    kind: "int",
    unit: "ms",
    description: "Fallback `claude` call when `startUrl` lands on a 404 — searches for a working URL.",
    riskLower: "fallback may give up on apps with slow routing",
    riskHigher: "almost never doing useful work past 60s",
  },

  // ── Plan generation ──────────────────────────────────────────────────
  {
    key: "TIK_MAX_GOALS",
    actionInput: "max-goals",
    default: 3,
    kind: "int",
    unit: "items",
    description: "Hard ceiling on goals the planner produces. The plan prompt sees `1-N` and the result is also defensively trimmed.",
    riskLower: "<2 leaves no room for an edge-case secondary goal",
    riskHigher: ">5 inflates video length past the ~60s scroll-feed sweet spot and may push the agent over the 25-min job budget",
  },

  // ── Body narration density ────────────────────────────────────────────
  {
    key: "TIK_MIN_CHUNK_S",
    actionInput: "min-chunk-seconds",
    default: 3.5,
    kind: "float",
    unit: "seconds",
    description: "Minimum body chunk length — shorter consecutive moments coalesce into the previous chunk.",
    riskLower: "<2s = many tiny scenes, narration prompt blows up, sonnet timeouts",
    riskHigher: ">6s = scenes feel sluggish, captions repeat themselves on screen",
  },
  {
    key: "TIK_MAX_BODY_SCENES",
    actionInput: "max-body-scenes",
    default: 12,
    kind: "int",
    unit: "items",
    description: "Hard ceiling on body scenes after coalescing. Above this we sample evenly.",
    riskLower: "<8 misses interesting moments — agent clicks then jump-cut",
    riskHigher: ">14 risks narration call timing out; bump TIK_NARRATION_TIMEOUT_MS too",
  },

  // ── Outro checklist sizing ────────────────────────────────────────────
  {
    key: "TIK_CHECKLIST_MIN_ITEMS",
    actionInput: "checklist-min-items",
    default: 4,
    kind: "int",
    unit: "items",
    description: "Minimum items the LLM must produce — below this we treat the call as failed (fall back to one row per goal).",
    riskLower: "<3 = checklist always looks empty even on small PRs",
    riskHigher: ">6 = LLM frequently 'fails' on tiny PRs that legitimately have only 3 things to check",
  },
  {
    key: "TIK_CHECKLIST_MAX_ITEMS",
    actionInput: "checklist-max-items",
    default: 10,
    kind: "int",
    unit: "items",
    description: "Maximum items rendered. Dense layout shrinks rows past 7. Empirically the largest count that stays scannable in 9:16.",
    riskLower: "<6 hides legitimately interesting checks",
    riskHigher: ">12 overflows the safe band — items get clipped on mobile",
  },

  // ── Intro / outro durations ───────────────────────────────────────────
  {
    key: "TIK_INTRO_TARGET_S",
    actionInput: "intro-seconds",
    default: 4.5,
    kind: "float",
    unit: "seconds",
    description: "Title-card window. Tells the narrator how long the intro line should be.",
    riskLower: "<3s = title flashes by, viewers miss PR context",
    riskHigher: ">6s = boring opening, viewers swipe away",
  },
  {
    key: "TIK_OUTRO_TARGET_S",
    actionInput: "outro-seconds",
    default: 4.0,
    kind: "float",
    unit: "seconds",
    description: "Outro narration window.",
    riskLower: "<3s = narrator races through the wrap-up",
    riskHigher: ">5s = drags after the action ends",
  },
  {
    key: "TIK_OUTRO_HOLD_S",
    actionInput: "outro-hold-seconds",
    default: 3.5,
    kind: "float",
    unit: "seconds",
    description: "Extra time the outro Sequence holds AFTER the voice ends so the checklist stays readable.",
    riskLower: "<2s = reviewers can't finish reading the checklist",
    riskHigher: ">5s = video feels long; auto-advance laggy",
  },
];

const KNOBS_BY_KEY: Map<string, Knob> = new Map(KNOBS.map((k) => [k.key, k]));

/** Lookup helper for error-message formatters that have only the env-var
 *  name (e.g. when a `runClaude` call times out). Returns `undefined` for
 *  unknown keys — caller falls back to a generic message. */
export function getKnob(key: string): Knob | undefined {
  return KNOBS_BY_KEY.get(key);
}

/** Format a "how to override this" hint suitable for an error message
 *  or the `tik-test config` listing. Mentions the env var AND, if the
 *  knob is exposed by the GitHub Action, the action input name too. */
export function overrideHint(knob: Knob): string {
  const base = `set env var ${knob.key}`;
  if (knob.actionInput) return `${base} OR pass \`${knob.actionInput}\` input to the GitHub Action`;
  return base;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`tik-test: ignoring invalid ${key}="${raw}" (expected positive integer), using default ${fallback}`);
    return fallback;
  }
  return n;
}
function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`tik-test: ignoring invalid ${key}="${raw}" (expected positive number), using default ${fallback}`);
    return fallback;
  }
  return n;
}

/** Resolve the current value for a knob — env override or default,
 *  with logging on invalid values. */
export function resolveKnob(knob: Knob): number {
  return knob.kind === "int" ? envInt(knob.key, knob.default) : envFloat(knob.key, knob.default);
}

// ── Exported constants ─────────────────────────────────────────────────
// One per KNOBS entry; the rest of the codebase imports these directly so
// the metadata table is invisible to callers that just need the number.

export const MAX_GOALS = resolveKnob(KNOBS_BY_KEY.get("TIK_MAX_GOALS")!);
export const PLAN_TIMEOUT_MS = resolveKnob(KNOBS_BY_KEY.get("TIK_PLAN_TIMEOUT_MS")!);
export const AGENT_TIMEOUT_MS = resolveKnob(KNOBS_BY_KEY.get("TIK_AGENT_TIMEOUT_MS")!);
export const NARRATION_TIMEOUT_MS = resolveKnob(KNOBS_BY_KEY.get("TIK_NARRATION_TIMEOUT_MS")!);
export const FEATURE_FINDER_TIMEOUT_MS = resolveKnob(KNOBS_BY_KEY.get("TIK_FEATURE_FINDER_TIMEOUT_MS")!);
export const MIN_CHUNK_S = resolveKnob(KNOBS_BY_KEY.get("TIK_MIN_CHUNK_S")!);
export const MAX_BODY_SCENES = resolveKnob(KNOBS_BY_KEY.get("TIK_MAX_BODY_SCENES")!);
export const CHECKLIST_MIN_ITEMS = resolveKnob(KNOBS_BY_KEY.get("TIK_CHECKLIST_MIN_ITEMS")!);
export const CHECKLIST_MAX_ITEMS = resolveKnob(KNOBS_BY_KEY.get("TIK_CHECKLIST_MAX_ITEMS")!);
export const INTRO_TARGET_S = resolveKnob(KNOBS_BY_KEY.get("TIK_INTRO_TARGET_S")!);
export const OUTRO_TARGET_S = resolveKnob(KNOBS_BY_KEY.get("TIK_OUTRO_TARGET_S")!);
export const OUTRO_HOLD_S = resolveKnob(KNOBS_BY_KEY.get("TIK_OUTRO_HOLD_S")!);
