/**
 * Pass 2 — DETERMINISTIC DEMO REPLAY.
 *
 * Pass 1 (the goal-agent) explores the app: lots of clicks, retries, probes,
 * loops. The recording is messy and the narrator has no time to land its
 * lines. Pass 2 fixes that: it takes the agent's STEPS output (a clean
 * linear demo per goal) and walks it with FIXED dwell between actions, so
 * every action gets human-watchable airtime and narration falls naturally
 * onto the right moment.
 *
 * No LLM in this loop. No MCP. Just Playwright user-facing locators
 * (getByRole / getByLabel / getByText) replaying the choreography pass 1
 * already proved works.
 */
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import type { DemoStep, RunArtifacts, StepEvent } from "./types.js";
import {
  BROKEN_IMAGE_FALLBACK,
  INTERACTION_RECORDER_INIT,
  MUTATION_RECORDER_INIT,
} from "./runner.js";

export interface GoalReplay {
  goalId: string;
  description: string;
  importance: "low" | "normal" | "high" | "critical";
  shortLabel?: string;
  shortNote?: string;
  outcome: "success" | "failure" | "skipped";
  note?: string;
  steps: DemoStep[];
}

export interface ReplayOptions {
  goals: GoalReplay[];
  /** Literal mouse + key interactions captured during pass 1's pre-test
   *  sign-in goal. Pass 2 replays them byte-for-byte when its fresh
   *  browser lands on a login screen — the storageState carryover only
   *  covers cookies + localStorage, so apps whose auth lives in-memory
   *  (or behind a session cookie that wasn't set in pass 1) need a fresh
   *  login. Replaying the literal bytes that worked once avoids asking
   *  an LLM to describe the flow back to us. */
  loginInteractions?: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>;
  runDir: string;
  startUrl: string;
  viewport: { width: number; height: number };
  headed: boolean;
  storageStatePath?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string; url?: string }>;
  extraHTTPHeaders?: Record<string, string>;
}

export interface ReplayArtifacts {
  rawVideoPath: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  events: StepEvent[];
  toolWindows: NonNullable<RunArtifacts["toolWindows"]>;
  interactions: NonNullable<RunArtifacts["interactions"]>;
  clickBboxes: NonNullable<RunArtifacts["clickBboxes"]>;
  mutations: NonNullable<RunArtifacts["mutations"]>;
  cameraPlan: NonNullable<RunArtifacts["cameraPlan"]>;
}

// Per-step pacing — tuned to LOOK HUMAN, not optimal. The recording is for
// a viewer who needs to follow what's happening, so every cursor approach
// glides, every key press lingers, every result holds long enough to read.
// Knobs:
const MOUSE_GLIDE_STEPS = 22;       // explicit cursor steps from prev pos to target
const MOUSE_GLIDE_SETTLE_MS = 140;  // pause once cursor lands on target
const PRE_ACTION_DWELL_MS = 480;    // additional dwell on target before clicking
const POST_ACTION_DWELL_MS = 1500;  // dwell after action so result is visible
const TYPE_PER_CHAR_MS = 95;        // letter-by-letter typing — visibly human
const POST_TYPE_PAUSE_MS = 320;     // pause before pressing Enter / clicking next
const GOAL_GAP_MS = 800;            // pause between goals
const TAIL_DWELL_MS = 1500;         // last frame of the body holds for the editor

/** Glide the cursor from its current position to (x, y) over multiple
 *  intermediate steps, then settle. Playwright's locator.click does its
 *  own short move, but we want a visible cursor trail in the recording —
 *  so we do an explicit slow move first. Returns true if the move
 *  actually happened (false if Playwright threw, e.g. closed page). */
async function glideTo(page: Page, x: number, y: number): Promise<boolean> {
  try {
    await page.mouse.move(x, y, { steps: MOUSE_GLIDE_STEPS });
    await page.waitForTimeout(MOUSE_GLIDE_SETTLE_MS);
    return true;
  } catch { return false; }
}

export async function replayDemo(opts: ReplayOptions): Promise<ReplayArtifacts> {
  const startedAt = new Date().toISOString();
  const runStart = performance.now();

  const videoDir = path.join(opts.runDir, "pass2-video");
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({
    headless: !opts.headed,
    args: [
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  const context: BrowserContext = await browser.newContext({
    viewport: opts.viewport,
    recordVideo: { dir: videoDir, size: opts.viewport },
    deviceScaleFactor: 1,
    storageState: opts.storageStatePath,
  });
  const recordingStart = performance.now();

  if (opts.cookies?.length) {
    await context.addCookies(opts.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      url: c.url,
      secure: true,
      sameSite: "Lax" as const,
    })));
  }
  // Reuse pass-1's same-origin Vercel bypass header behaviour so the preview
  // URL is reachable in pass 2 just like it was in pass 1.
  const previewHost = (() => {
    try { return new URL(opts.startUrl).host; } catch { return ""; }
  })();
  if (opts.extraHTTPHeaders && previewHost) {
    await context.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      let sameHost = false;
      try { sameHost = new URL(reqUrl).host === previewHost; } catch {}
      if (sameHost) await route.continue({ headers: { ...route.request().headers(), ...opts.extraHTTPHeaders } });
      else await route.continue();
    });
  }

  // Page-side recorders — same shape as pass 1 so the editor doesn't care
  // which pass produced them. Skip TIK_HISTORY / freeze (agent-only).
  const interactions: NonNullable<RunArtifacts["interactions"]> = [];
  await context.exposeFunction("__tikRecord", (data: { kind: "move" | "click" | "key"; x: number; y: number; key?: string }) => {
    interactions.push({ ts: Math.max(0, Math.round(performance.now() - recordingStart)), ...data });
  });
  const clickBboxes: NonNullable<RunArtifacts["clickBboxes"]> = [];
  await context.exposeFunction("__tikRecordClickBbox", (data: { x: number; y: number; width: number; height: number }) => {
    clickBboxes.push({ ts: Math.max(0, Math.round(performance.now() - recordingStart)), ...data });
  });
  const mutations: NonNullable<RunArtifacts["mutations"]> = [];
  await context.exposeFunction("__tikRecordMutation", (data: { x: number; y: number; width: number; height: number }) => {
    mutations.push({ ts: Math.max(0, Math.round(performance.now() - recordingStart)), ...data });
  });
  await context.addInitScript(INTERACTION_RECORDER_INIT);
  await context.addInitScript(MUTATION_RECORDER_INIT);
  await context.addInitScript(BROKEN_IMAGE_FALLBACK);

  const page = await context.newPage();

  const events: StepEvent[] = [];
  const toolWindows: NonNullable<RunArtifacts["toolWindows"]> = [];
  // Camera plan — one entry per demo step. The agent's `camera` directive
  // on each step drives mode (tight / wide / follow); focus comes from the
  // step's click bbox if it's tight (else inherits the most recent click
  // for follow, or is unset for wide).
  const cameraPlan: NonNullable<RunArtifacts["cameraPlan"]> = [];

  try {
    console.log(chalk.cyan(`\n  pass 2 — replaying ${opts.goals.length} demo goal${opts.goals.length === 1 ? "" : "s"}`));
    await page.goto(opts.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Brief settle time so the initial frame isn't blank.
    await page.waitForTimeout(800);

    // ── LOGIN DETECTION.
    // The storageState carryover from pass 1 covers cookies + localStorage,
    // but NOT in-memory auth flags. Apps whose login state lives only in a
    // React component's useState (the taskpad demo, plenty of dev-mode
    // login gates, "any password works" demos) come up as login forms in
    // pass 2's fresh browser. If we see a visible password input within
    // 1.5s of pageload, replay the login STEPS the pre-test sign-in agent
    // emitted in pass 1 — same labels, same flow. Generic for any app
    // whose tiktest.md declares credentials.
    const passwordInput = page.locator('input[type="password"]');
    let onLogin = false;
    try { onLogin = await passwordInput.first().isVisible({ timeout: 1500 }); } catch {}
    if (onLogin) {
      const ints = (opts.loginInteractions ?? []).filter((i) => i.kind === "click" || i.kind === "key");
      if (ints.length > 0) {
        const counts = ints.reduce<Record<string, number>>((acc, i) => { acc[i.kind] = (acc[i.kind] ?? 0) + 1; return acc; }, {});
        console.log(chalk.dim(`     login screen detected — replaying ${ints.length} captured interactions (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")})`));
        await replayLoginInteractions(page, ints);
        // Give the app time to switch surfaces (animate the gate out,
        // mount the main view, fetch initial data).
        await page.waitForTimeout(1500);
        try {
          const stillOnLogin = await passwordInput.first().isVisible({ timeout: 800 });
          if (stillOnLogin) console.log(chalk.yellow(`     login replay completed but a password input is still visible — goal demos may fail`));
          else console.log(chalk.dim(`     login replay successful — login form gone, proceeding with goal demos`));
        } catch {
          console.log(chalk.dim(`     login replay successful — login form gone, proceeding with goal demos`));
        }
      } else {
        console.log(chalk.yellow(`     login screen detected but no login interactions were captured in pass 1 — goal demos will likely fail`));
      }
    }

    for (let gi = 0; gi < opts.goals.length; gi++) {
      const goal = opts.goals[gi];
      const goalStartMs = Math.max(0, Math.round(performance.now() - recordingStart));
      console.log(chalk.dim(`     ${gi + 1}/${opts.goals.length}  ${goal.shortLabel || goal.description.slice(0, 48)} (${goal.steps.length} steps)`));

      // The current step's click bbox (mutated by record.click). Used at
      // step end to pin the camera plan's focus point when mode === "tight".
      let stepClickCx: number | null = null;
      let stepClickCy: number | null = null;
      const record = {
        click: (cx: number, cy: number, bbox?: { x: number; y: number; width: number; height: number }) => {
          const ts = Math.max(0, Math.round(performance.now() - recordingStart));
          interactions.push({ ts, kind: "click", x: cx, y: cy });
          if (bbox) clickBboxes.push({ ts, x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height });
          stepClickCx = cx;
          stepClickCy = cy;
        },
        key: (key: string) => {
          interactions.push({
            ts: Math.max(0, Math.round(performance.now() - recordingStart)),
            kind: "key",
            x: 0,
            y: 0,
            key,
          });
        },
      };
      // Track the most recent click coords across the goal — when a step
      // (e.g. wait, press) has no click of its own, "tight" / "follow"
      // inherits the previous click as its focus point.
      let lastClickCx: number | null = null;
      let lastClickCy: number | null = null;
      // ── Input-focus camera lock.
      // Once the user starts typing into a field, the viewer's eye is
      // locked on that field — we should NOT pull back to wide while the
      // text appears. The lock holds across subsequent waits / presses
      // (Enter to submit, etc.) and only releases on the next click,
      // which by definition shifts focus elsewhere. Coords come from the
      // type step's click (we always click the input first).
      let typingLock: { x: number; y: number } | null = null;

      for (const step of goal.steps) {
        const stepStartMs = Math.max(0, Math.round(performance.now() - recordingStart));
        stepClickCx = null;
        stepClickCy = null;
        let stepFailed = false;
        try {
          await runStep(page, step, record);
        } catch (e) {
          stepFailed = true;
          console.log(chalk.yellow(`       step skipped: ${describeStep(step)} — ${(e as Error).message.split("\n")[0].slice(0, 100)}`));
          // Log a tool window so the editor doesn't think this was dead air.
          const stepEndMs = Math.max(stepStartMs + 50, Math.round(performance.now() - recordingStart));
          toolWindows.push({
            startMs: stepStartMs,
            endMs: stepEndMs,
            kind: `replay_${step.kind}_skipped`,
            input: describeStep(step),
            result: (e as Error).message.split("\n")[0].slice(0, 200),
          });
        }
        if (!stepFailed) {
          const stepEndMs = Math.max(stepStartMs + 50, Math.round(performance.now() - recordingStart));
          toolWindows.push({
            startMs: stepStartMs,
            endMs: stepEndMs,
            kind: `replay_${step.kind}`,
            input: describeStep(step),
            result: step.hint,
          });
        }
        // Update the goal-level "last click" cursor from this step's click.
        if (stepClickCx !== null && stepClickCy !== null) {
          lastClickCx = stepClickCx;
          lastClickCy = stepClickCy;
        }
        // Update the typing lock based on what we just executed.
        // - `type`: enter / extend the lock at the input's coords.
        // - `click`: shift focus → release the lock.
        // - `press` / `wait` / `select` / `navigate`: leave it alone.
        if (step.kind === "type" && stepClickCx !== null && stepClickCy !== null) {
          typingLock = { x: stepClickCx, y: stepClickCy };
        } else if (step.kind === "click") {
          typingLock = null;
        }
        // Build the camera plan entry. Default to wide; agent's `camera`
        // wins. BUT while the typing lock is active, force tight on the
        // focused input regardless of what the agent picked — viewers
        // should never lose sight of the field whose content is changing.
        const stepEndMs = Math.max(stepStartMs + 50, Math.round(performance.now() - recordingStart));
        let mode: "tight" | "wide" | "follow" = step.camera ?? "wide";
        if (typingLock) mode = "tight";
        const entry: { startMs: number; endMs: number; mode: typeof mode; focusX?: number; focusY?: number } = {
          startMs: stepStartMs,
          endMs: stepEndMs,
          mode,
        };
        if (mode === "tight" || mode === "follow") {
          // Prefer the typing lock if active (the input's location), then
          // this step's own click, then the most recent click anywhere.
          const fx = typingLock?.x ?? stepClickCx ?? lastClickCx;
          const fy = typingLock?.y ?? stepClickCy ?? lastClickCy;
          if (fx !== null && fx !== undefined && fy !== null && fy !== undefined) {
            entry.focusX = fx;
            entry.focusY = fy;
          }
        }
        cameraPlan.push(entry);
      }

      const goalEndMs = Math.max(goalStartMs + 200, Math.round(performance.now() - recordingStart));
      events.push({
        stepId: goal.goalId,
        description: goal.description,
        kind: "intent",
        importance: goal.importance,
        startMs: goalStartMs,
        endMs: goalEndMs,
        outcome: goal.outcome,
        notes: goal.note,
        shortLabel: goal.shortLabel,
        shortNote: goal.shortNote,
      });

      // Pause between goals so the verification stamp has clean airtime.
      await page.waitForTimeout(GOAL_GAP_MS);
    }

    await page.waitForTimeout(TAIL_DWELL_MS);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Move the recorded webm out of its hash-named location.
  const fs = await import("node:fs/promises");
  const dirEntries = await fs.readdir(videoDir);
  const vid = dirEntries.find((f) => f.endsWith(".webm"));
  if (!vid) throw new Error("pass 2 produced no video");
  const rawVideoPath = path.join(opts.runDir, "raw-pass2.webm");
  await rename(path.join(videoDir, vid), rawVideoPath);

  const finishedAt = new Date().toISOString();
  const totalMs = Math.round(performance.now() - runStart);

  if (interactions.length) {
    await writeFile(path.join(opts.runDir, "pass2-interactions.json"), JSON.stringify(interactions, null, 2));
    const byKind: Record<string, number> = {};
    for (const it of interactions) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(chalk.dim(`  pass 2 interactions: ${interactions.length} (${breakdown})`));
  }
  console.log(chalk.dim(`  pass 2 done: ${(totalMs / 1000).toFixed(1)}s body, ${events.length} goals, ${toolWindows.length} step windows`));

  if (cameraPlan.length > 0) {
    const counts = cameraPlan.reduce<Record<string, number>>((a, e) => { a[e.mode] = (a[e.mode] ?? 0) + 1; return a; }, {});
    console.log(chalk.dim(`  camera plan: ${cameraPlan.length} entries (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")})`));
  }

  return {
    rawVideoPath,
    startedAt,
    finishedAt,
    totalMs,
    events,
    toolWindows,
    interactions,
    clickBboxes,
    mutations,
    cameraPlan,
  };
}

/** Try each candidate locator in priority order; the first that resolves
 *  (within a short timeout) wins. Strategy order:
 *    1. ARIA role + accessible name (when role is supplied)
 *    2. getByLabel (for type / select — matches form labels)
 *    3. getByPlaceholder (for type — matches input placeholder)
 *    4. getByText (catch-all — buttons, links, anything visible) */
async function firstResolvable(page: Page, step: DemoStep): Promise<Locator> {
  const label = step.label?.trim();
  if (!label) throw new Error(`step.label is required for kind=${step.kind}`);
  const tryList: Array<() => Locator> = [];
  if (step.role) {
    tryList.push(() => page.getByRole(step.role as Parameters<Page["getByRole"]>[0], { name: label, exact: false }).first());
  }
  if (step.kind === "type") {
    tryList.push(() => page.getByLabel(label, { exact: false }).first());
    tryList.push(() => page.getByPlaceholder(label, { exact: false }).first());
  }
  if (step.kind === "select") {
    tryList.push(() => page.getByLabel(label, { exact: false }).first());
  }
  tryList.push(() => page.getByText(label, { exact: false }).first());

  let lastErr: Error | null = null;
  for (const make of tryList) {
    const loc = make();
    try {
      await loc.waitFor({ state: "visible", timeout: 2500 });
      return loc;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw new Error(`could not resolve locator for label="${label}" (${tryList.length} strategies tried): ${lastErr?.message?.slice(0, 80)}`);
}

interface Recorder {
  click: (cx: number, cy: number, bbox?: { x: number; y: number; width: number; height: number }) => void;
  key: (key: string) => void;
}

async function runStep(page: Page, step: DemoStep, record: Recorder): Promise<void> {
  switch (step.kind) {
    case "navigate": {
      if (!step.url) throw new Error("navigate step missing url");
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    case "wait": {
      const ms = Math.max(0, Math.min(8000, step.ms ?? 1500));
      await page.waitForTimeout(ms);
      return;
    }
    case "press": {
      if (!step.key) throw new Error("press step missing key");
      // Brief dwell so the previous step's narration finishes before the key fires.
      await page.waitForTimeout(PRE_ACTION_DWELL_MS);
      await page.keyboard.press(step.key);
      record.key(step.key);
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    case "click": {
      const loc = await firstResolvable(page, step);
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const bbox = await loc.boundingBox().catch(() => null);
      // Glide the cursor across the page in many small steps so the
      // recording shows a real human-paced approach, not an instantaneous
      // teleport. We move BEFORE locator.click so this glide is what
      // actually plays out on screen (locator.click does its own short
      // move at the end which is fine since we're already on target).
      if (bbox) await glideTo(page, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      await page.waitForTimeout(PRE_ACTION_DWELL_MS);
      await loc.click({ timeout: 5000 });
      if (bbox) record.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, bbox);
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    case "type": {
      if (step.value === undefined) throw new Error("type step missing value");
      const loc = await firstResolvable(page, step);
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const bbox = await loc.boundingBox().catch(() => null);
      // Glide cursor onto the input first.
      if (bbox) await glideTo(page, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      await loc.click({ timeout: 5000 });
      if (bbox) record.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, bbox);
      await page.waitForTimeout(POST_TYPE_PAUSE_MS);
      // Clear first if the field already has content — keeps demo deterministic.
      try { await loc.fill(""); } catch {}
      // Type letter-by-letter at human pace. pressSequentially fires real
      // keydown/keypress/input events for each character, so the cursor
      // overlay's keystroke recorder catches every one.
      await loc.pressSequentially(step.value, { delay: TYPE_PER_CHAR_MS });
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    case "select": {
      if (step.value === undefined) throw new Error("select step missing value");
      const loc = await firstResolvable(page, step);
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const bbox = await loc.boundingBox().catch(() => null);
      if (bbox) await glideTo(page, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      await page.waitForTimeout(PRE_ACTION_DWELL_MS);
      await loc.selectOption(step.value, { timeout: 5000 });
      if (bbox) record.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, bbox);
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    default:
      throw new Error(`unknown step kind: ${(step as DemoStep).kind}`);
  }
}

/** Replay pass-1's literal login interactions byte-for-byte. We use the
 *  exact x/y coords for clicks and pass each key character through
 *  page.keyboard.press. No locators, no labels, no LLM — just the bytes
 *  that worked the first time, with small natural delays between events
 *  so the visible effect is human-paced (focus → caret → typed chars
 *  appearing → next field).
 *
 *  Why coordinate-level replay instead of agent-emitted STEPS:
 *  - The agent is asked to paraphrase what it did into label-keyed steps;
 *    that translation is lossy. Coords + key events are not.
 *  - Login rendering doesn't shift between pass 1 and pass 2 (same
 *    viewport, same code path, no animations that move inputs).
 *  - Robust to any sign-in UI: dev-mode "any password" gates,
 *    SSO-emulated buttons, multi-step forms — if the agent could click
 *    its way through them once, the same clicks work again. */
async function replayLoginInteractions(
  page: Page,
  events: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>,
): Promise<void> {
  // Coalesce contiguous key events on the same tick boundary into one
  // type() call — keeps replay snappy when the agent typed a long string.
  // Mixed click/key sequences play out in original order.
  const sorted = events.slice().sort((a, b) => a.ts - b.ts);
  let i = 0;
  while (i < sorted.length) {
    const ev = sorted[i];
    if (ev.kind === "click") {
      // Glide to the click point — same many-step move as the demo replay
      // uses so the cursor approach reads as natural, not as a teleport.
      try {
        await page.mouse.move(ev.x, ev.y, { steps: MOUSE_GLIDE_STEPS });
        await page.waitForTimeout(MOUSE_GLIDE_SETTLE_MS);
        await page.mouse.click(ev.x, ev.y);
      } catch {}
      await page.waitForTimeout(280);
      i++;
    } else if (ev.kind === "key") {
      // Gather contiguous keys (no click in between).
      let j = i;
      const keys: string[] = [];
      while (j < sorted.length && sorted[j].kind === "key") {
        if (sorted[j].key) keys.push(sorted[j].key as string);
        j++;
      }
      // Single-character "printable" runs go through type() so they look
      // like real typing. Special keys (length>1, e.g. "Enter", "Tab",
      // "Backspace", "ArrowDown") press individually.
      let runStart = 0;
      for (let k = 0; k <= keys.length; k++) {
        const isEnd = k === keys.length;
        const special = !isEnd && keys[k].length > 1;
        if (isEnd || special) {
          if (k > runStart) {
            const word = keys.slice(runStart, k).join("");
            try { await page.keyboard.type(word, { delay: TYPE_PER_CHAR_MS }); } catch {}
          }
          if (!isEnd && special) {
            try { await page.keyboard.press(keys[k]); } catch {}
            await page.waitForTimeout(160);
            runStart = k + 1;
          }
        }
      }
      await page.waitForTimeout(280);
      i = j;
    } else {
      // skip "move" — page.mouse.click already does the cursor move
      i++;
    }
  }
}

function describeStep(step: DemoStep): string {
  switch (step.kind) {
    case "click": return `click "${step.label ?? ""}"`;
    case "type": return `type "${(step.value ?? "").slice(0, 40)}" into "${step.label ?? ""}"`;
    case "press": return `press ${step.key ?? ""}`;
    case "select": return `select "${step.value ?? ""}" in "${step.label ?? ""}"`;
    case "wait": return `wait ${step.ms ?? 0}ms`;
    case "navigate": return `navigate ${step.url ?? ""}`;
    default: return JSON.stringify(step);
  }
}

