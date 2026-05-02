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
  /** STEPS emitted by the pre-test sign-in agent. Replayed on pass-2's
   *  fresh browser whenever the start URL lands on a login screen — the
   *  storageState carryover only covers cookies + localStorage, so apps
   *  whose auth lives in-memory (or behind a session cookie that wasn't
   *  set during pass 1) need a fresh login before the goal demos run. */
  loginSteps?: DemoStep[];
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
}

// Per-step pacing. Tuned for narration headroom: each click gets at least
// ~2.4s on screen between approach and the next action, which is enough
// for a 6-9 word narration line at natural speaking rate.
const PRE_ACTION_DWELL_MS = 600;   // sit on the target so cursor settles before fire
const POST_ACTION_DWELL_MS = 1500; // dwell after action so result is visible
const TYPE_PER_CHAR_MS = 60;       // human-paced typing
const GOAL_GAP_MS = 800;           // pause between goals
const TAIL_DWELL_MS = 1500;        // last frame of the body holds for the editor

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
      if (opts.loginSteps?.length) {
        console.log(chalk.dim(`     login screen detected — replaying ${opts.loginSteps.length} login step${opts.loginSteps.length === 1 ? "" : "s"}`));
        const loginRecorder = {
          click: (cx: number, cy: number, bbox?: { x: number; y: number; width: number; height: number }) => {
            const ts = Math.max(0, Math.round(performance.now() - recordingStart));
            interactions.push({ ts, kind: "click", x: cx, y: cy });
            if (bbox) clickBboxes.push({ ts, x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height });
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
        for (const step of opts.loginSteps) {
          try { await runStep(page, step, loginRecorder); } catch (e) {
            console.log(chalk.yellow(`     login step skipped: ${describeStep(step)} — ${(e as Error).message.split("\n")[0].slice(0, 100)}`));
          }
        }
        // After login, give the app time to switch surfaces (some apps
        // animate the gate out, mount the main view, fetch initial data).
        await page.waitForTimeout(1200);
        // Sanity check: did we get past the login form? If a password
        // input is STILL visible we're going to fail every locator below
        // anyway — log and proceed (the goal demos will skip cleanly).
        try {
          const stillOnLogin = await passwordInput.first().isVisible({ timeout: 800 });
          if (stillOnLogin) console.log(chalk.yellow(`     login replay completed but a password input is still visible — goal demos may fail`));
        } catch {}
      } else {
        console.log(chalk.yellow(`     login screen detected but no login STEPS were captured in pass 1 — goal demos will likely fail`));
      }
    }

    for (let gi = 0; gi < opts.goals.length; gi++) {
      const goal = opts.goals[gi];
      const goalStartMs = Math.max(0, Math.round(performance.now() - recordingStart));
      console.log(chalk.dim(`     ${gi + 1}/${opts.goals.length}  ${goal.shortLabel || goal.description.slice(0, 48)} (${goal.steps.length} steps)`));

      const record = {
        click: (cx: number, cy: number, bbox?: { x: number; y: number; width: number; height: number }) => {
          const ts = Math.max(0, Math.round(performance.now() - recordingStart));
          interactions.push({ ts, kind: "click", x: cx, y: cy });
          if (bbox) clickBboxes.push({ ts, x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height });
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

      for (const step of goal.steps) {
        const stepStartMs = Math.max(0, Math.round(performance.now() - recordingStart));
        try {
          await runStep(page, step, record);
        } catch (e) {
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
          continue;
        }
        const stepEndMs = Math.max(stepStartMs + 50, Math.round(performance.now() - recordingStart));
        toolWindows.push({
          startMs: stepStartMs,
          endMs: stepEndMs,
          kind: `replay_${step.kind}`,
          input: describeStep(step),
          result: step.hint,
        });
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
      // Hover before click so the cursor overlay glides to the target before
      // the flash fires — mirrors how a person would move toward a button.
      await loc.hover({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(PRE_ACTION_DWELL_MS);
      // Capture the bbox BEFORE the click so we know exactly where the
      // animation should fire even if the element vanishes/changes after.
      const bbox = await loc.boundingBox().catch(() => null);
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
      await loc.click({ timeout: 5000 });
      if (bbox) record.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, bbox);
      await page.waitForTimeout(300);
      // Clear first if the field already has content — keeps demo deterministic.
      try { await loc.fill(""); } catch {}
      await loc.pressSequentially(step.value, { delay: TYPE_PER_CHAR_MS });
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    case "select": {
      if (step.value === undefined) throw new Error("select step missing value");
      const loc = await firstResolvable(page, step);
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const bbox = await loc.boundingBox().catch(() => null);
      await loc.selectOption(step.value, { timeout: 5000 });
      if (bbox) record.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, bbox);
      await page.waitForTimeout(POST_ACTION_DWELL_MS);
      return;
    }
    default:
      throw new Error(`unknown step kind: ${(step as DemoStep).kind}`);
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

