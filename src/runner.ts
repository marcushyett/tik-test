import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import chalk from "chalk";
import type { BBox, PlanStep, RunArtifacts, StepEvent, TestPlan } from "./types.js";
import { runSetup } from "./setup.js";

function resolveSelector(target: string): string {
  const t = target.trim();
  const roleMatch = /^role=([a-z]+)(?:\[name=(.+)\])?$/i.exec(t);
  if (roleMatch) {
    const role = roleMatch[1];
    const name = roleMatch[2]?.replace(/^["']|["']$/g, "");
    return name ? `role=${role}[name="${name}"]` : `role=${role}`;
  }
  if (t.startsWith("text=") || t.startsWith("role=") || t.startsWith("//") || t.startsWith("[") || t.startsWith("#") || t.startsWith(".")) return t;
  return t;
}

async function captureBBox(page: Page, locator: Locator, at: "before" | "after"): Promise<BBox | undefined> {
  try {
    const box = await locator.boundingBox();
    if (!box) return undefined;
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: vp.width, viewportHeight: vp.height, at };
  } catch {
    return undefined;
  }
}

/**
 * Track where we last put the cursor so humanMove can draw an eased path
 * from there to the target instead of teleporting. Playwright's `steps`
 * option fires N intermediate mousemove events but completes in ~zero wall
 * time — so the synthetic cursor lerps to the target in a blur. We instead
 * chunk the move into ~24 frames spread over ~640ms so the viewer's eye can
 * follow the pointer.
 */
let lastCursor: { x: number; y: number } | null = null;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function humanMove(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  const from = lastCursor ?? { x: vp.width / 2, y: vp.height * 0.62 };
  const dx = targetX - from.x;
  const dy = targetY - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < 4) {
    await page.mouse.move(targetX, targetY);
    lastCursor = { x: targetX, y: targetY };
    return;
  }
  // Slower motion — the viewer needs to follow the pointer to the target,
  // so paths run 700-1500ms regardless of distance. Short paths no longer
  // teleport; long paths don't overshoot but give the eye time to track.
  const durationMs = Math.max(700, Math.min(1500, distance * 1.4));
  const frames = 28;
  const frameMs = Math.round(durationMs / frames);
  // Perpendicular offset so the path arcs slightly — feels less robotic than a
  // straight line. Magnitude scales with distance but caps at ~40px.
  const arc = Math.min(40, distance * 0.18) * (Math.random() > 0.5 ? 1 : -1);
  const perpX = -dy / distance;
  const perpY = dx / distance;
  for (let i = 1; i <= frames; i++) {
    const t = easeInOutCubic(i / frames);
    // sin(π t) peaks mid-path, so the arc bulges at 50% then relaxes.
    const bulge = Math.sin(Math.PI * (i / frames)) * arc;
    const x = from.x + dx * t + perpX * bulge + (Math.random() - 0.5) * 0.6;
    const y = from.y + dy * t + perpY * bulge + (Math.random() - 0.5) * 0.6;
    await page.mouse.move(x, y);
    await page.waitForTimeout(frameMs);
  }
  lastCursor = { x: targetX, y: targetY };
}

/**
 * "Look here" gesture — pulses a ring on the page without actually clicking.
 * Used on assert-visible / assert-text so the viewer can see what the narrator
 * is referring to ("look at the green toast"). The pan-zoom already tracks the
 * bbox; this just draws attention within the frame.
 */
async function pulseFocus(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.evaluate(([x, y]) => {
    const fn = (window as any).__tikPulse as undefined | ((x: number, y: number) => void);
    if (fn) fn(x, y);
  }, [cx, cy]);
}

async function runStep(page: Page, step: PlanStep, startUrl: string): Promise<{ notes?: string; bbox?: BBox }> {
  const timeout = 15_000;
  switch (step.kind) {
    case "navigate": {
      const url = step.target
        ? (step.target.startsWith("http") ? step.target : new URL(step.target, startUrl).toString())
        : startUrl;
      // domcontentloaded fires before images/videos finish — that's why ad
      // thumbnails and video previews were blank in the recording. Wait for
      // networkidle (or cap at 10s) so the async media has a chance to land.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      return {};
    }
    case "click": {
      if (!step.target) throw new Error("click step requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "before");
      await page.waitForTimeout(1350); // "thinking" beat — reader locates the button first
      if (bbox) await humanMove(page, bbox);
      await page.waitForTimeout(750); // pointer hovers briefly before the click
      await locator.click({ timeout });
      await page.waitForTimeout(2400); // let the UI reaction play out on-screen
      return { bbox };
    }
    case "fill": {
      if (!step.target) throw new Error("fill step requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "before");
      await page.waitForTimeout(900);
      if (bbox) await humanMove(page, bbox);
      await page.waitForTimeout(500);
      await locator.click({ timeout });
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      // Visible typing — each key is a distinct frame for the viewer to read.
      await locator.type(step.value ?? "", { delay: 220 });
      await page.waitForTimeout(1500);
      return { bbox };
    }
    case "press": {
      const key = step.value ?? step.target ?? "Enter";
      if (step.target && step.target !== key) {
        const locator = page.locator(resolveSelector(step.target)).first();
        const bbox = await captureBBox(page, locator, "before");
        await locator.press(key, { timeout });
        return { bbox };
      }
      await page.keyboard.press(key);
      return {};
    }
    case "hover": {
      if (!step.target) throw new Error("hover step requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "before");
      await locator.hover({ timeout });
      return { bbox };
    }
    case "wait": {
      // Hard cap so a Claude-authored plan that asks for "wait 30000ms to let
      // cache revalidate" doesn't balloon the video. Long settle times are
      // covered by the editor's idle-compression anyway.
      const ms = Math.min(3000, Number(step.value ?? "800"));
      await page.waitForTimeout(ms);
      return { notes: `waited ${ms}ms` };
    }
    case "assert-visible": {
      if (!step.target) throw new Error("assert-visible requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "after");
      // POINT at what we're confirming so the video/pan-zoom tracks it, and
      // pulse a ring so the narration ("look — the toast") has something visual.
      if (bbox) {
        await humanMove(page, bbox);
        await page.waitForTimeout(250);
        await pulseFocus(page, bbox);
        await page.waitForTimeout(850);
      }
      return { notes: "visible — ok", bbox };
    }
    case "assert-text": {
      if (!step.target) throw new Error("assert-text requires target");
      // Claude sometimes emits assert-text without a value (mistakes it for
      // assert-visible). Fall back to visibility check rather than fail the
      // step for a plan-generator quirk.
      if (!step.value) {
        const locator = page.locator(resolveSelector(step.target)).first();
        await locator.waitFor({ state: "visible", timeout });
        const bbox = await captureBBox(page, locator, "after");
        if (bbox) {
          await humanMove(page, bbox);
          await page.waitForTimeout(250);
          await pulseFocus(page, bbox);
          await page.waitForTimeout(750);
        }
        return { notes: "visible — ok (value missing, treated as assert-visible)", bbox };
      }
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const text = (await locator.innerText()).trim();
      if (!text.includes(step.value)) throw new Error(`Expected text to include "${step.value}", got "${text.slice(0, 80)}"`);
      const bbox = await captureBBox(page, locator, "after");
      // Hover + pulse on the asserted element so the viewer can see what the
      // voice-over is talking about.
      if (bbox) {
        await humanMove(page, bbox);
        await page.waitForTimeout(250);
        await pulseFocus(page, bbox);
        await page.waitForTimeout(950);
      }
      return { notes: `contains: ${step.value}`, bbox };
    }
    case "screenshot": {
      // handled by runner
      return {};
    }
    case "script": {
      if (!step.value) throw new Error("script requires value");
      await page.evaluate(step.value);
      return {};
    }
  }
}

export interface RunOptions {
  plan: TestPlan;
  runDir: string;
  headed?: boolean;
  extraHTTPHeaders?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string; url?: string }>;
  storageStatePath?: string;
  /** Natural-language pre-test setup/login instructions from the repo's
   *  README "TikTest" section. Executed after initial navigation, before the
   *  plan steps run, so the plan sees an already-authed app. */
  setupInstructions?: string;
}

/**
 * CSS + JS that paints a synthetic cursor so the RECORDED video actually shows
 * a pointer moving around. Playwright's recordVideo captures page content only;
 * the OS cursor is invisible. We hook mousemove and render an overlay.
 */
const SYNTHETIC_CURSOR_INIT = `
window.addEventListener('DOMContentLoaded', () => {
  const cursor = document.createElement('div');
  cursor.id = '__tik_cursor__';
  cursor.style.cssText = [
    'position:fixed','z-index:2147483647','pointer-events:none',
    'width:28px','height:28px','top:0','left:0',
    // Slower lerp so the pointer glides instead of snapping.
    'transform:translate(-5px,-3px)','transition:transform 60ms linear',
  ].join(';');
  cursor.innerHTML = \`
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2 L3 22 L8.5 17 L12 25 L15 23.5 L11.5 15.5 L19 15.5 Z"
        fill="#ffffff" stroke="#0a0a0a" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>\`;
  document.body.appendChild(cursor);
  let vx = 0, vy = 0, tx = 0, ty = 0;
  function tick() {
    // Softer lerp coefficient (0.17 vs 0.28) so the visible pointer trails the
    // real mouse more — easier for a viewer to track.
    vx += (tx - vx) * 0.17;
    vy += (ty - vy) * 0.17;
    cursor.style.transform = \`translate(\${vx - 5}px, \${vy - 3}px)\`;
    requestAnimationFrame(tick);
  }
  tick();
  document.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; }, true);
  function ripple(x, y, color) {
    const c = color || '#00e5a0';
    const r = document.createElement('div');
    r.style.cssText = [
      'position:fixed','z-index:2147483646','pointer-events:none',
      'left:' + x + 'px','top:' + y + 'px',
      'width:10px','height:10px','margin:-5px 0 0 -5px',
      'border-radius:50%','border:3px solid ' + c,'opacity:0.9',
      'animation:tikRipple 520ms ease-out forwards','box-shadow:0 0 28px ' + c,
    ].join(';');
    document.body.appendChild(r);
    setTimeout(function() { r.remove(); }, 560);
  }
  // Click ripple.
  document.addEventListener('click', function(e) { ripple(e.clientX, e.clientY, '#00e5a0'); }, true);
  // Non-click "look here" pulse — a warm amber ring so the viewer can see what
  // we're asserting on even when the pointer is stationary. Triggered from the
  // Playwright runner on assert steps.
  (window).__tikPulse = function(x, y) {
    ripple(x, y, '#ffb94a');
    // Second, larger concentric ring for extra presence.
    setTimeout(function() { ripple(x, y, '#ffb94a'); }, 160);
  };
  const style = document.createElement('style');
  style.textContent = '@keyframes tikRipple{from{transform:scale(1);opacity:0.9}to{transform:scale(10);opacity:0}}';
  document.head.appendChild(style);
});
`;

export async function runPlan({ plan, runDir, headed, extraHTTPHeaders, cookies, storageStatePath, setupInstructions }: RunOptions): Promise<RunArtifacts> {
  await mkdir(runDir, { recursive: true });
  const videoDir = path.join(runDir, "video");
  await mkdir(videoDir, { recursive: true });
  const shotsDir = path.join(runDir, "screenshots");
  await mkdir(shotsDir, { recursive: true });

  const viewport = plan.viewport ?? { width: 1280, height: 800 };
  const startedAt = new Date().toISOString();
  const runStart = performance.now();

  const browser: Browser = await chromium.launch({ headless: !headed });
  const context: BrowserContext = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
    deviceScaleFactor: 1,
    extraHTTPHeaders,
    storageState: storageStatePath,
  });
  if (cookies?.length) {
    await context.addCookies(cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      url: c.url,
      secure: true,
      sameSite: "Lax" as const,
    })));
  }
  await context.addInitScript(SYNTHETIC_CURSOR_INIT);
  const page = await context.newPage();

  const events: StepEvent[] = [];
  const logLine = (label: string, step: PlanStep, extra = "") => {
    const pad = String(events.length + 1).padStart(2, "0");
    console.log(`  ${chalk.dim(pad)} ${label} ${chalk.bold(step.description)}${extra ? chalk.dim("  " + extra) : ""}`);
  };

  try {
    // Always navigate to startUrl first so the setup phase has a valid page.
    await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Let network settle so images/videos in the app UI render before we
    // start recording interactions. Capped to keep a slow CDN from blocking
    // the run indefinitely.
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});

    // Pre-test setup: execute README's TikTest instructions (auth, seeding,
    // etc.) so the plan runs against a prepared, logged-in app. Setup
    // failures abort the run loudly — the whole point is to not waste a
    // render on a stuck-at-login recording.
    if (setupInstructions) {
      try {
        await runSetup(page, setupInstructions, plan.startUrl);
      } catch (e) {
        throw new Error(`TikTest setup (README) failed — aborting before plan run. ${(e as Error).message}`);
      }
      // After auth, the app likely redirected us to a dashboard. Re-navigate
      // to the plan's start URL so the plan's first step is on the feature
      // page (not wherever the post-auth redirect dropped us).
      const postSetupUrl = page.url();
      try {
        const samePage = new URL(postSetupUrl).pathname === new URL(plan.startUrl).pathname;
        if (!samePage) {
          console.log(chalk.dim(`  returning to ${new URL(plan.startUrl).pathname} after setup (was ${new URL(postSetupUrl).pathname})`));
          await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
          await page.waitForTimeout(800);
        }
      } catch {}
    }

    // If the first plan step is also a navigate to the same start URL, skip
    // the duplicate hop — setup may have already moved us to a different URL.
    const first = plan.steps[0];
    const firstIsDupNav = first?.kind === "navigate" && (!first.target || first.target === plan.startUrl);
    const stepsToRun = firstIsDupNav ? plan.steps.slice(1) : plan.steps;
    for (const step of stepsToRun) {
      const t0 = performance.now();
      const startMs = Math.max(0, Math.round(t0 - runStart));
      let outcome: StepEvent["outcome"] = "success";
      let error: string | undefined;
      let notes: string | undefined;
      let screenshotPath: string | undefined;
      logLine(chalk.cyan("▶"), step);
      let bbox: BBox | undefined;
      try {
        const res = await runStep(page, step, plan.startUrl);
        notes = res.notes;
        bbox = res.bbox;
        if (step.kind === "screenshot" || step.importance === "critical" || step.importance === "high") {
          const p = path.join(shotsDir, `${step.id}.png`);
          await page.screenshot({ path: p, fullPage: false });
          screenshotPath = p;
        }
      } catch (e) {
        outcome = step.optional ? "skipped" : "failure";
        error = (e as Error).message.split("\n")[0];
        try {
          const p = path.join(shotsDir, `${step.id}-fail.png`);
          await page.screenshot({ path: p, fullPage: false });
          screenshotPath = p;
        } catch {}
        logLine(chalk.red("✗"), step, error);
      }
      const endMs = Math.max(startMs + 50, Math.round(performance.now() - runStart));
      events.push({
        stepId: step.id,
        description: step.description,
        kind: step.kind,
        importance: step.importance ?? "normal",
        startMs,
        endMs,
        outcome,
        error,
        notes,
        screenshotPath,
        bbox,
      });
      if (outcome === "success") logLine(chalk.green("✓"), step, notes ?? "");
      // Extra dwell so the editor has ample footage — critical beats get longer, since the
      // voice-over on them tends to be more expansive.
      const dwell =
        outcome === "failure" ? 1600 :
        step.importance === "critical" ? 1400 :
        step.importance === "high" ? 1100 :
        800;
      await page.waitForTimeout(dwell);
    }
    // Extra tail dwell so the final step has video content for the editor to hold on.
    await page.waitForTimeout(1500);
  } finally {
    // Close page first to flush video
    await page.close();
    await context.close();
    await browser.close();
  }

  // Find recorded video file (Playwright gives it a hash name in videoDir)
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(videoDir);
  const vid = entries.find((f) => f.endsWith(".webm"));
  if (!vid) throw new Error("No video recorded by Playwright");
  const rawVideoPath = path.join(runDir, "raw.webm");
  await rename(path.join(videoDir, vid), rawVideoPath);

  const finishedAt = new Date().toISOString();
  const totalMs = Math.round(performance.now() - runStart);

  const artifacts: RunArtifacts = {
    runDir,
    rawVideoPath,
    eventsJsonPath: path.join(runDir, "events.json"),
    events,
    plan,
    startedAt,
    finishedAt,
    totalMs,
  };
  await writeFile(artifacts.eventsJsonPath, JSON.stringify({ plan, events, startedAt, finishedAt, totalMs }, null, 2));
  await writeFile(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
  return artifacts;
}
