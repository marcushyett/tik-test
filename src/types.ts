/** What kind of action a StepEvent describes. Goal-based runs only emit
 *  "intent" events; the other kinds are emitted by setup / runtime page
 *  handling (navigate, wait, script). */
export type StepKind = "navigate" | "wait" | "script" | "intent" | "click" | "fill" | "press" | "hover";

export interface Goal {
  id: string;
  /** Natural-language goal — what we want an autonomous agent to verify.
   *  Generic example: "Navigate to the new feature page and exercise the primary action." */
  intent: string;
  /** SHORT (3-5 words, ≤32 chars) headline rendered on the outro checklist.
   *  Must be scannable — the reviewer reads ten of these in 3 seconds. */
  shortLabel?: string;
  /** Optional observable success condition the agent should stop at. */
  success?: string;
  importance?: "low" | "normal" | "high" | "critical";
}

export interface TestPlan {
  name: string;
  summary: string;
  startUrl: string;
  viewport?: { width: number; height: number };
  /** High-level goals driven by an autonomous agent. */
  goals?: Goal[];
}

export type EventOutcome = "success" | "failure" | "skipped";

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  at: "before" | "after"; // captured before or after the interaction
}

export interface StepEvent {
  stepId: string;
  description: string;
  kind: StepKind;
  importance: "low" | "normal" | "high" | "critical";
  startMs: number;
  endMs: number;
  outcome: EventOutcome;
  error?: string;
  screenshotPath?: string;
  notes?: string;
  /** Short headline copied from Goal.shortLabel — for the outro checklist. */
  shortLabel?: string;
  /** Short outcome explanation produced by the goal-agent (5-9 words). */
  shortNote?: string;
  bbox?: BBox;
}

export interface RunArtifacts {
  runDir: string;
  rawVideoPath: string;
  eventsJsonPath: string;
  events: StepEvent[];
  plan: TestPlan;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  /** Fine-grained active-window hints from the agent's per-tool-call timestamps.
   *  The editor uses these to trim agent-thinking lulls WITHIN a goal event,
   *  and (via `result` string) surfaces non-tech overlays in the video so the
   *  viewer sees what the agent found during otherwise static tool calls. */
  toolWindows?: Array<{ startMs: number; endMs: number; kind: string; input?: string; result?: string }>;
}

export interface Config {
  url: string;
  name?: string;
  viewport?: { width: number; height: number };
  /** `start: <cmd>` directive parsed from the project markdown. Spawned
   *  as a background process before the test phase so local-dev runs
   *  can launch the app server. Not used in CI (deployment_status events
   *  supply a real URL). */
  setup?: string;
  /** Project-level natural-language setup blob from tiktest.md (or fallback
   *  README.md `## TikTest` section). Describes the app, login, where the
   *  preview lives, etc. Stable across PRs; the same content reaches every
   *  Claude call. The agent reads it during plan generation AND during
   *  goal execution (so it can sign in autonomously when needed). */
  projectContext?: string;
  /**
   * Raw PR diff, truncated to a prompt-safe size. Populated by `tik-test pr`
   * from `gh pr diff`. Lets the plan generator target the specific files
   * and lines a PR touches instead of guessing from the PR body alone.
   */
  diff?: string;
  /**
   * Human-authored PR comments (tik-test's own comments are excluded).
   * Teammates often drop hints like "make sure to try it with 0 items" or
   * "watch the error when you hit submit twice" — surfacing those to the
   * plan generator gives the video a reviewer-steering angle instead of
   * purely diff-driven coverage.
   */
  comments?: string;
  /** PR-specific testing notes assembled from PR title + body. Distinct
   *  from projectContext: changes per PR, lives in the PR description. */
  prContext?: string;
  plan?: TestPlan;
  music?: string;
}
