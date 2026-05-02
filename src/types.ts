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
  /** Plan generator's verdict on whether this PR has any chance of
   *  affecting user-facing behaviour — directly OR via a backend
   *  endpoint that powers a UI surface. When `true`, the diff is a
   *  genuine no-op (pure docs / lockfile-only / unrelated config) and
   *  the rest of the run is skipped cleanly with a "skipped" comment +
   *  neutral check-run conclusion. The agent decides; tik-test does
   *  NOT pre-classify files by extension or path. */
  noOp?: boolean;
  /** Short reason returned alongside `noOp: true` — surfaced verbatim in
   *  the skipped PR comment so reviewers know WHY the run was skipped
   *  ("only README + lockfile changed", "moves a CI workflow", etc). */
  noOpReason?: string;
}

export type EventOutcome = "success" | "failure" | "skipped";

/** A single user action in a CHOREOGRAPHED demo replay (pass 2). The
 *  agent (pass 1) emits a list of these per goal — its summary of what
 *  a viewer should see to understand the feature. Pass 2 walks them
 *  with deliberate dwell so narration has room to land per step.
 *
 *  Locator strategy: `label` + optional `role` resolve via Playwright's
 *  user-facing locators (getByRole / getByLabel / getByPlaceholder /
 *  getByText fallback). The agent picks `label` from what it actually
 *  saw on screen during pass 1, so the same label resolves in pass 2's
 *  fresh browser. */
export interface DemoStep {
  kind: "click" | "type" | "press" | "select" | "wait" | "navigate";
  /** User-facing element name for click / type / select. Examples: "Add task",
   *  "Email", "Priority". Required for click/type/select. */
  label?: string;
  /** ARIA role for click — sharpens the match when label is generic. */
  role?: string;
  /** For type: the text to type. For select: the option value/label. */
  value?: string;
  /** For press: the key (e.g. "Enter", "Escape"). */
  key?: string;
  /** For wait: how long to hold (ms). Used between actions when the page
   *  needs time to settle but no further click makes sense. */
  ms?: number;
  /** For navigate: the URL — only valid when changing app surface mid-demo. */
  url?: string;
  /** Optional caption hint — what to mention while this step plays.
   *  The post-recording narrator uses this verbatim or as a starting point. */
  hint?: string;
  /** Camera intent for this step's window — replaces the previous reactive
   *  click-driven zoom logic with an agent-planned directive. The agent
   *  picks one mode per step based on what the viewer should be looking
   *  at while that step plays. Default if omitted: "wide".
   *
   *  - "tight" — zoom in on the action point (the step's click target,
   *    or the most recent click if this step is a wait/press). Use when
   *    a specific control IS the subject.
   *  - "wide"  — full page view. Use for context-establishing shots and
   *    for moments where the result spans the page (a list updates, a
   *    toast appears in the corner, multiple things change at once).
   *  - "follow" — start tight on the action, ease out to wide over the
   *    step's duration. Use when an action triggers a visible side effect
   *    elsewhere on the page that the viewer needs to see. */
  camera?: "tight" | "wide" | "follow";
}

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
  /** Mouse + click + keystroke stream captured from the page. `ts` is in raw-video
   *  ms (= performance.now() at event time minus runStart). Remotion uses this to
   *  render a cinematic cursor overlay and pan-zoom toward each click bbox. `move`
   *  is throttled to ~30Hz, `click` and `key` are unthrottled. */
  interactions?: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>;
  /** Bounding rect of the element clicked at each click event, in viewport
   *  pixels (same coord space as `interactions`). Captured page-side from
   *  `event.target.getBoundingClientRect()`. The editor uses these alongside
   *  `mutations` below to detect post-click DOM updates that landed OUTSIDE
   *  the clicked element — the signal that pan-zoom should release. */
  clickBboxes?: Array<{ ts: number; x: number; y: number; width: number; height: number }>;
  /** Agent-planned camera plan for the body — one window per demo step,
   *  keyed to RAW recording-relative ms (same timeline as toolWindows /
   *  events). Each entry has a `mode` directive (tight / wide / follow)
   *  and an optional viewport-pixel focus point. Replaces the reactive
   *  click-driven pan-zoom with explicit creative direction from the
   *  agent that designed the demo. The editor maps these to body-relative
   *  seconds via the trim plan; the Remotion compositor lerps zoom +
   *  focus between consecutive entries for smooth transitions. */
  cameraPlan?: Array<{ startMs: number; endMs: number; mode: "tight" | "wide" | "follow"; focusX?: number; focusY?: number }>;
  /** DOM mutations observed page-side via a MutationObserver, with each
   *  mutation's bounding rect at observation time. The editor pairs these
   *  with `clickBboxes` to find post-click off-target page changes that
   *  warrant releasing the held pan-zoom (toast in corner, counter top-right
   *  updates, etc.). Bursts of mutations within the same node group are
   *  throttled page-side so we don't drown in keystroke-driven entries. */
  mutations?: Array<{ ts: number; x: number; y: number; width: number; height: number }>;
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
  /** Optional sign-in button label declared by the consumer's tiktest.md
   *  frontmatter (`signin-button:`). When present, the runner uses it to
   *  word a more actionable failure when login can't proceed: "expected
   *  button matching `<label>` not found, visible buttons were: …". */
  expectedSignInButton?: string;
}
