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
  | "script";

export interface PlanStep {
  id: string;
  kind: StepKind;
  description: string;
  target?: string;
  value?: string;
  importance?: "low" | "normal" | "high" | "critical";
  optional?: boolean;
}

export interface TestPlan {
  name: string;
  summary: string;
  startUrl: string;
  viewport?: { width: number; height: number };
  steps: PlanStep[];
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
}

export interface Config {
  url: string;
  name?: string;
  viewport?: { width: number; height: number };
  setup?: string;
  login?: string;
  focus?: string;
  /**
   * Raw PR diff, truncated to a prompt-safe size. Populated by `tik-test pr`
   * from `gh pr diff`, not by human-written claude.md files. Lets the plan
   * generator target the specific files/lines a PR touches instead of
   * guessing from the PR body alone.
   */
  diff?: string;
  plan?: TestPlan;
  music?: string;
}
