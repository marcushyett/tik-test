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
      await locator.click({ timeout });
      return { bbox };
    }
    case "fill": {
      if (!step.target) throw new Error("fill step requires target");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const bbox = await captureBBox(page, locator, "before");
      await locator.fill(step.value ?? "", { timeout });
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
      return { notes: "visible — ok", bbox };
    }
    case "assert-text": {
      if (!step.target || !step.value) throw new Error("assert-text requires target and value");
      const locator = page.locator(resolveSelector(step.target)).first();
      await locator.waitFor({ state: "visible", timeout });
      const text = (await locator.innerText()).trim();
      if (!text.includes(step.value)) throw new Error(`Expected text to include "${step.value}", got "${text.slice(0, 80)}"`);
      const bbox = await captureBBox(page, locator, "after");
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
}

export async function runPlan({ plan, runDir, headed }: RunOptions): Promise<RunArtifacts> {
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
  });
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
      // Dwell so the recording captures final state and there's something to linger on.
      const dwell = step.importance === "critical" ? 900 : step.importance === "high" ? 700 : 450;
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
