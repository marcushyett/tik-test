export type StepKind =
  | "navigate"
  | "click"
  | "fill"
  | "press"
  | "hover"
  | "wait"
  | "assert-visible"
  | "assert-text"
  | "screenshot"
  | "script"
  | "intent";

export interface PlanStep {
  id: string;
  kind: StepKind;
  description: string;
  target?: string;
  value?: string;
  importance?: "low" | "normal" | "high" | "critical";
  optional?: boolean;
}

export interface Goal {
  id: string;
  /** Natural-language goal — what we want an autonomous agent to verify.
   *  E.g. "Navigate to the Inspiration page and open Theater Mode". */
  intent: string;
  /** Optional observable success condition the agent should stop at. */
  success?: string;
  importance?: "low" | "normal" | "high" | "critical";
}

export interface TestPlan {
  name: string;
  summary: string;
  startUrl: string;
  viewport?: { width: number; height: number };
  /** New: high-level goals driven by an autonomous agent. Preferred. */
  goals?: Goal[];
  /** Legacy step-by-step plan. Kept for backwards compatibility with old
   *  claude.md files that include a pre-baked Test Plan JSON. */
  steps?: PlanStep[];
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
   *  The editor uses these to trim agent-thinking lulls WITHIN a goal event.
   *  Without them, each goal is one big active window and nothing inside trims. */
  toolWindows?: Array<{ startMs: number; endMs: number; kind: string }>;
}

export interface Config {
  url: string;
  name?: string;
  viewport?: { width: number; height: number };
  setup?: string;
  login?: string;
  /** README "TikTest" section — natural-language login / pre-test setup
   *  instructions. Executed before plan generation so the rest of the run
   *  assumes an already-authed, test-ready page. */
  tiktestSetup?: string;
  focus?: string;
  /**
   * Raw PR diff, truncated to a prompt-safe size. Populated by `tik-test pr`
   * from `gh pr diff`, not by human-written claude.md files. Lets the plan
   * generator target the specific files/lines a PR touches instead of
   * guessing from the PR body alone.
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
  plan?: TestPlan;
  music?: string;
}
