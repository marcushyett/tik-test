import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import chalk from "chalk";
import type { BBox, PlanStep, RunArtifacts, StepEvent, TestPlan } from "./types.js";

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
 * Move the mouse from its current position to the centre of the element in ~18
 * stepped frames with an ease-out curve. Playwright's default `locator.click`
 * teleports the cursor — invisible in a recording — so we move by hand first.
 */
async function humanMove(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  const steps = 22;
  await page.mouse.move(targetX, targetY, { steps });
}

async function humanJitter(page: Page): Promise<void> {
  // Small wiggle so the pointer feels alive between actions.
  const vp = page.viewportSize();
  if (!vp) return;
  const jitter = (v: number) => v + (Math.random() - 0.5) * 16;
  // Nudge from wherever Playwright's cursor is — we can't read it, so pick a neutral spot.
  await page.mouse.move(jitter(vp.width / 2), jitter(vp.height / 2), { steps: 12 });
}

async function runStep(page: Page, step: PlanStep, startUrl: string): Promise<{ notes?: string; bbox?: BBox }> {
  const timeout = 15_000;
  switch (step.kind) {
    case "navigate": {
      const url = step.target
        ? (step.target.startsWith("http") ? step.target : new URL(step.target, startUrl).toString())
        : startUrl;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return {};
    }
    case "click": {
      if (!step.target) throw new Error("click step requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "before");
      await page.waitForTimeout(650); // thinking beat
      if (bbox) await humanMove(page, bbox);
      await page.waitForTimeout(300); // pointer hovers briefly before the click
      await locator.click({ timeout });
      await page.waitForTimeout(1300); // settle so the UI reaction is on-screen
      return { bbox };
    }
    case "fill": {
      if (!step.target) throw new Error("fill step requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "before");
      await page.waitForTimeout(400);
      if (bbox) await humanMove(page, bbox);
      await page.waitForTimeout(200);
      await locator.click({ timeout });
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      // Slower typing — the viewer should see letters appear, one by one.
      await locator.type(step.value ?? "", { delay: 140 });
      await page.waitForTimeout(900);
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
      const ms = Number(step.value ?? "800");
      await page.waitForTimeout(ms);
      return { notes: `waited ${ms}ms` };
    }
    case "assert-visible": {
      if (!step.target) throw new Error("assert-visible requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "after");
      // POINT at what we're confirming so the video/pan-zoom tracks it.
      if (bbox) {
        await humanMove(page, bbox);
        await page.waitForTimeout(600);
      }
      return { notes: "visible — ok", bbox };
    }
    case "assert-text": {
      if (!step.target || !step.value) throw new Error("assert-text requires target and value");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const text = (await locator.innerText()).trim();
      if (!text.includes(step.value)) throw new Error(`Expected text to include "${step.value}", got "${text.slice(0, 80)}"`);
      const bbox = await captureBBox(page, locator, "after");
      // Hover on the asserted element so the viewer can see what the voice-over is talking about.
      if (bbox) {
        await humanMove(page, bbox);
        await page.waitForTimeout(700);
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
    'transform:translate(-5px,-3px)','transition:transform 40ms linear',
  ].join(';');
  cursor.innerHTML = \`
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2 L3 22 L8.5 17 L12 25 L15 23.5 L11.5 15.5 L19 15.5 Z"
        fill="#ffffff" stroke="#0a0a0a" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>\`;
  document.body.appendChild(cursor);
  let vx = 0, vy = 0, tx = 0, ty = 0, raf = 0;
  function tick() {
    vx += (tx - vx) * 0.28;
    vy += (ty - vy) * 0.28;
    cursor.style.transform = \`translate(\${vx - 5}px, \${vy - 3}px)\`;
    raf = requestAnimationFrame(tick);
  }
  tick();
  document.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; }, true);
  // Click ripple.
  document.addEventListener('click', (e) => {
    const r = document.createElement('div');
    r.style.cssText = [
      'position:fixed','z-index:2147483646','pointer-events:none',
      'left:' + e.clientX + 'px','top:' + e.clientY + 'px',
      'width:10px','height:10px','margin:-5px 0 0 -5px',
      'border-radius:50%','border:3px solid #00e5a0','opacity:0.9',
      'animation:tikRipple 500ms ease-out forwards','box-shadow:0 0 24px #00e5a0',
    ].join(';');
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 520);
  }, true);
  const style = document.createElement('style');
  style.textContent = '@keyframes tikRipple{from{transform:scale(1);opacity:0.9}to{transform:scale(9);opacity:0}}';
  document.head.appendChild(style);
});
`;

export async function runPlan({ plan, runDir, headed, extraHTTPHeaders, cookies, storageStatePath }: RunOptions): Promise<RunArtifacts> {
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
    // Always start with initial navigation if first step isn't navigate
    const first = plan.steps[0];
    if (!first || first.kind !== "navigate") {
      await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    for (const step of plan.steps) {
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
