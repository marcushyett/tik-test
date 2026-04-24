import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import chalk from "chalk";
import type { BBox, PlanStep, RunArtifacts, StepEvent, TestPlan } from "./types.js";
import { runSetup } from "./setup.js";
import { findFeature, isFeaturePageReady } from "./feature-finder.js";
import { runGoal } from "./goal-agent.js";

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

/**
 * Wait for all visible <img> elements on the page to finish loading (or fail
 * visibly). React apps with async data and IntersectionObserver-gated image
 * loaders routinely finish AFTER networkidle fires — this helper fills that
 * gap so the recording has actual thumbnails, not blank placeholders.
 *
 * We consider an image "done" when it reports complete=true AND naturalWidth>0
 * (browsers set naturalWidth=0 on errored images, which we don't want to wait
 * forever on). Images that error out are counted as done so we never block.
 */
async function waitForImagesLoaded(page: Page, timeoutMs = 10_000): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const imgs = Array.from(document.images).filter((img) => {
        // Skip tiny (icon/badge) images and explicitly off-screen ones — they're
        // often not the thumbnails we care about and can be slow to settle.
        const r = (img as HTMLImageElement).getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return false;
        return true;
      });
      if (imgs.length === 0) return true;
      return imgs.every((img) => {
        const el = img as HTMLImageElement;
        if (el.complete && el.naturalWidth > 0) return true;
        if (el.complete && el.naturalWidth === 0) return true; // errored — don't block
        return false;
      });
    }, { timeout: timeoutMs });
  } catch {
    // Cap reached — some images never settled. Fine; we tried.
  }
}

/**
 * Nudge the page to trigger IntersectionObserver-based lazy loaders. Many
 * React apps (including next/image) only request thumbnails when they enter
 * the viewport. A short scroll-down-then-scroll-back is enough to prime the
 * loaders without disrupting the "first frame" the video lands on.
 */
async function primeLazyImages(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const originalY = window.scrollY;
      const steps = [400, 800, 1200, 1600];
      for (const y of steps) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 80));
      }
      window.scrollTo(0, originalY);
      await new Promise((r) => setTimeout(r, 120));
    });
  } catch {}
}

/** Combined routine: prime lazy loaders + wait for their images to land. */
async function settleMedia(page: Page): Promise<void> {
  await primeLazyImages(page);
  await waitForImagesLoaded(page);
  // Diagnostic: report any image that claims complete but has zero width
  // (i.e. failed to decode) OR any video that hasn't loaded its poster.
  try {
    const report = await page.evaluate(() => {
      const imgs = Array.from(document.images).filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      });
      const videos = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
      return {
        imgTotal: imgs.length,
        imgBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        imgBrokenSamples: imgs.filter((i) => i.complete && i.naturalWidth === 0).slice(0, 3).map((i) => i.currentSrc || i.src),
        imgOkSample: imgs.filter((i) => i.complete && i.naturalWidth > 0).slice(0, 1).map((i) => i.currentSrc || i.src),
        videoTotal: videos.length,
        videoLoaded: videos.filter((v) => v.readyState >= 2).length,
        videoPosters: videos.slice(0, 3).map((v) => ({ src: v.currentSrc, poster: v.poster, readyState: v.readyState, error: v.error?.code })),
      };
    });
    if (report.imgBroken > 0 || (report.videoTotal > 0 && report.videoLoaded === 0)) {
      console.log(chalk.yellow(`  [media report] imgs: ${report.imgTotal} total, ${report.imgBroken} broken; videos: ${report.videoTotal} total, ${report.videoLoaded} loaded`));
      if (report.imgBrokenSamples.length > 0) {
        for (const url of report.imgBrokenSamples) {
          console.log(chalk.yellow(`    broken img: ${url.slice(0, 140)}`));
        }
      }
      if (report.videoPosters.length > 0) {
        for (const v of report.videoPosters) {
          console.log(chalk.yellow(`    video src=${(v.src || "").slice(0, 80)} poster=${(v.poster || "").slice(0, 80)} readyState=${v.readyState}${v.error ? " err=" + v.error : ""}`));
        }
      }
      if (report.imgOkSample.length > 0) {
        console.log(chalk.dim(`    (ok img sample: ${report.imgOkSample[0].slice(0, 140)})`));
      }
    }
  } catch {}
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
  // Intent-kind steps are handled by the goal-agent path upstream, not here.
  if (step.kind === "intent") return {};
  switch (step.kind) {
    case "navigate": {
      // URL-guessing by the plan generator is routinely wrong — Claude can't
      // know whether the real route is /chat or /gruns/chat from a diff's
      // file paths alone, and wrong guesses 404. Always navigate to the
      // startUrl (preview root) and let the next plan step click its way
      // into the feature, like a user would.
      const requested = step.target
        ? (step.target.startsWith("http") ? step.target : new URL(step.target, startUrl).toString())
        : startUrl;
      const url = requested !== startUrl ? startUrl : requested;
      if (requested !== startUrl) {
        console.log(chalk.dim(`    (ignoring plan's guessed URL ${requested} — going to preview root instead)`));
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      // Prime lazy-loaded thumbnails + wait for them to actually render.
      await settleMedia(page);
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
      // Claude-authored script values routinely use top-level `return`,
      // which is invalid when evaluate treats the string as a program.
      // Wrap in an IIFE so the script runs in function scope and returns
      // behave as expected.
      const wrapped = `(async () => { ${step.value} })()`;
      await page.evaluate(wrapped);
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
  /** PR diff (truncated) — used by the feature-finder to pick where to
   *  navigate when the plan's startUrl lands on a 404 or an unrelated page. */
  diff?: string;
  /** PR comments — reviewer feedback / "make sure to test X" hints. Passed
   *  to the goal-agent so it can incorporate specific guidance (e.g. "the
   *  existing cached data is broken, trigger a new fetch first"). */
  comments?: string;
  /** PR title — gives the agent a one-line summary of the change. */
  prTitle?: string;
  /** PR description / body — the "why" behind the change. */
  prBody?: string;
}

/**
 * CSS + JS that paints a synthetic cursor so the RECORDED video actually shows
 * a pointer moving around. Playwright's recordVideo captures page content only;
 * the OS cursor is invisible. We hook mousemove and render an overlay.
 */
/**
 * Replace broken <img> thumbnails with a neutral placeholder so the video
 * recording doesn't show ugly gray boxes when third-party CDN assets fail
 * (expired signatures, ORB, rate-limiting, etc).
 *
 * The app being tested can't know its upstream thumbnails are stale, and
 * we can't fix the upstream data from here — but at least the recorded
 * video can show a clean "preview unavailable" card instead of a blank.
 */
const BROKEN_IMAGE_FALLBACK = `
(() => {
  const PLACEHOLDER =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice">' +
        '<defs>' +
          '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#1e293b"/>' +
            '<stop offset="1" stop-color="#0f172a"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<rect width="400" height="600" fill="url(#bg)"/>' +
        '<g transform="translate(200 260)" fill="#64748b">' +
          '<circle r="28" fill="none" stroke="#64748b" stroke-width="4"/>' +
          '<path d="M-10 -8 L10 0 L-10 8 Z" fill="#64748b"/>' +
        '</g>' +
        '<text x="200" y="360" text-anchor="middle" fill="#cbd5e1" font-family="system-ui,sans-serif" font-size="20" font-weight="500">preview unavailable</text>' +
      '</svg>'
    );
  function fix(img) {
    if (!img || img.dataset.tikFallback === '1') return;
    if (img.complete && img.naturalWidth > 0) return;
    img.dataset.tikFallback = '1';
    img.src = PLACEHOLDER;
    img.removeAttribute('srcset');
  }
  function hook(img) {
    if (img.tagName !== 'IMG') return;
    img.addEventListener('error', () => fix(img), { once: true, capture: true });
    if (img.complete) {
      // Check naturalWidth after a tick — some failing responses still set complete=true.
      setTimeout(() => {
        if (img.complete && img.naturalWidth === 0) fix(img);
      }, 1500);
    }
  }
  const scan = (root) => {
    try { root.querySelectorAll('img').forEach(hook); } catch {}
  };
  function init() {
    scan(document);
    try {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'IMG') hook(n);
            else scan(n);
          }
        }
      }).observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {}
  }
  if (document.readyState !== 'loading') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
`;

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

export async function runPlan({ plan, runDir, headed, extraHTTPHeaders, cookies, storageStatePath, setupInstructions, diff, comments, prTitle, prBody }: RunOptions): Promise<RunArtifacts> {
  await mkdir(runDir, { recursive: true });
  const videoDir = path.join(runDir, "video");
  await mkdir(videoDir, { recursive: true });
  const shotsDir = path.join(runDir, "screenshots");
  await mkdir(shotsDir, { recursive: true });

  const viewport = plan.viewport ?? { width: 1280, height: 800 };
  const startedAt = new Date().toISOString();
  const runStart = performance.now();

  // `--disable-web-security` turns off all the cross-origin protections
  // (ORB, CORB, CORS, etc) for this test session. Without it, Chromium
  // refuses to render third-party CDN thumbnails (tiktokcdn.com, fbcdn
  // etc) with net::ERR_BLOCKED_BY_ORB — a feature-flag-level disable via
  // --disable-features=OpaqueResponseBlocking didn't take effect (the
  // feature name varies across Chromium versions). `--disable-web-security`
  // is the standard "testing tool" escape hatch and is documented for
  // exactly this use case.
  // Fixed CDP port so Playwright MCP can attach to the same browser we're
  // recording, via --cdp-endpoint ws://localhost:9223/... (port 9222 is
  // Chrome's default and often in use). Playwright's wsEndpoint() returns
  // the ws URL after launch — we hand it to MCP when we spawn the agent.
  const browser: Browser = await chromium.launch({
    headless: !headed,
    args: [
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--remote-debugging-port=9223",
    ],
  });
  // Discover the CDP ws URL so Playwright MCP can attach to the same
  // browser we're recording. Chrome exposes it at
  // http://localhost:9223/json/version once --remote-debugging-port is up.
  // This keeps recording/cookies/bypass plumbing intact while MCP drives.
  let cdpEndpoint = "";
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch("http://localhost:9223/json/version");
      if (resp.ok) {
        const j = (await resp.json()) as { webSocketDebuggerUrl?: string };
        if (j.webSocketDebuggerUrl) { cdpEndpoint = j.webSocketDebuggerUrl; break; }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!cdpEndpoint) throw new Error("Failed to discover CDP endpoint on port 9223");
  console.log(chalk.dim(`  cdp: ${cdpEndpoint}`));
  const context: BrowserContext = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
    deviceScaleFactor: 1,
    // Note: we intentionally DON'T pass extraHTTPHeaders here — when applied
    // at the context level, Playwright sends those headers on EVERY request
    // (including to third-party CDNs like Vercel Blob, Facebook's fbcdn,
    // Cloudflare, etc). CDNs sometimes reject requests with unexpected
    // headers, so ad thumbnails and similar assets come back as 4xx and
    // render as broken images in the video. Instead we intercept requests
    // below and only add the Vercel bypass header for same-origin traffic
    // on the preview domain.
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
  // Scope the Vercel protection-bypass header to the preview host only.
  // Vercel sets a `_vercel_jwt` cookie on the first hop (via the header +
  // `x-vercel-set-bypass-cookie` query param or header), so subsequent same-
  // origin requests are authed by cookie and don't need the header. Third-
  // party image hosts never need it at all.
  const previewHost = (() => {
    try { return new URL(plan.startUrl).host; } catch { return ""; }
  })();
  if (extraHTTPHeaders && previewHost) {
    await context.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      let sameHost = false;
      try { sameHost = new URL(reqUrl).host === previewHost; } catch {}
      if (sameHost) {
        await route.continue({ headers: { ...route.request().headers(), ...extraHTTPHeaders } });
      } else {
        await route.continue();
      }
    });
  }
  // Diagnostic: log any media request that fails (non-2xx or aborted).
  // Helps confirm whether thumbnails are blocked by CORS, auth, or codec —
  // when everything succeeds this is silent.
  context.on("response", async (resp) => {
    try {
      const url = resp.url();
      const status = resp.status();
      const ct = resp.headers()["content-type"] || "";
      const isMedia = /image|video|audio|octet-stream/i.test(ct) || /\.(png|jpe?g|webp|gif|avif|mp4|webm|m3u8|ts)(\?|$)/i.test(url);
      if (isMedia && (status < 200 || status >= 400)) {
        console.log(chalk.yellow(`  [media ${status}] ${url.slice(0, 120)}${url.length > 120 ? "…" : ""}`));
      }
    } catch {}
  });
  context.on("requestfailed", (req) => {
    const url = req.url();
    const resourceType = req.resourceType();
    if (resourceType === "image" || resourceType === "media") {
      console.log(chalk.yellow(`  [media FAILED ${resourceType}] ${url.slice(0, 120)}${url.length > 120 ? "…" : ""} · ${req.failure()?.errorText || "unknown"}`));
    }
  });
  await context.addInitScript(SYNTHETIC_CURSOR_INIT);
  await context.addInitScript(BROKEN_IMAGE_FALLBACK);
  const page = await context.newPage();

  const events: StepEvent[] = [];
  const logLine = (label: string, step: PlanStep, extra = "") => {
    const pad = String(events.length + 1).padStart(2, "0");
    console.log(`  ${chalk.dim(pad)} ${label} ${chalk.bold(step.description)}${extra ? chalk.dim("  " + extra) : ""}`);
  };

  // Per-tool-call active-window hints from the agent — declared at function
  // scope so they survive the try block and reach the RunArtifacts builder.
  const toolWindows: Array<{ startMs: number; endMs: number; kind: string; input?: string; result?: string }> = [];

  try {
    // Always navigate to startUrl first so the setup phase has a valid page.
    await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Let network settle, then prime lazy-loaders + wait for images so the
    // app's thumbnails are actually rendered before we start recording.
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await settleMedia(page);

    // Pre-test setup: execute README's TikTest instructions (auth, seeding,
    // etc.) so the plan runs against a prepared, logged-in app. If setup
    // fails we WARN and continue — the goal-agent is autonomous and can
    // drive sign-in itself from the snapshot. Aborting here on a flaky
    // Claude-generated setup step was wasting runs.
    if (setupInstructions) {
      try {
        await runSetup(page, setupInstructions, plan.startUrl);
      } catch (e) {
        console.log(chalk.yellow(`  ! setup failed but continuing — agent will handle from here: ${(e as Error).message.split("\n")[0]}`));
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
          await settleMedia(page);
          await page.waitForTimeout(800);
        } else {
          await settleMedia(page);
        }
      } catch {}
    }

    // Feature-finder: if setup left us on a 404, still-on-sign-in, or
    // otherwise blank page, ask Claude to navigate from home to wherever
    // the PR's feature actually lives. This replaces the old "just run
    // the plan and hope every step finds its target" behaviour with an
    // explicit "locate the feature first" phase.
    {
      const check = await isFeaturePageReady(page);
      if (!check.ready) {
        try {
          await findFeature(page, plan, diff, check.reason ?? "page not usable");
        } catch (e) {
          console.log(chalk.yellow(`  feature-finder errored (${(e as Error).message.split("\n")[0]}) — proceeding anyway`));
        }
      }
    }

    // GOAL-BASED PATH: autonomous agent executes each goal end-to-end,
    // figuring out selectors and sequences on the fly. This is the
    // preferred shape for plans generated from the current prompt.
    if (plan.goals && plan.goals.length > 0) {
      // Build PR context once — the agent gets it every turn, so the
      // diff/comments inform click decisions even without pre-planned
      // selectors. Order by signal density: title, reviewer comments
      // (often contain explicit "make sure to test X" hints), body, diff.
      // Order the context so reviewer instructions are impossible to miss:
      // REVIEWER NOTES first (loud + explicit that they're authoritative),
      // then PR title, body, diff. Agent keeps ignoring buried comment
      // directives; the heading + top placement + all-caps label fix that.
      const ctxParts: string[] = [];
      if (comments && comments.trim()) {
        ctxParts.push(
          `REVIEWER NOTES (AUTHORITATIVE — these are instructions from people who already tested this PR. If any note says "do X before you assert Y", you MUST do X. Ignoring a reviewer note and declaring failure is itself a failure.):\n${comments.trim()}`,
        );
      }
      if (prTitle) ctxParts.push(`PR TITLE:\n${prTitle.trim()}`);
      if (prBody && prBody.trim()) ctxParts.push(`PR DESCRIPTION:\n${prBody.trim()}`);
      if (diff && diff.trim()) ctxParts.push(`CODE DIFF (truncated):\n${diff.trim()}`);
      const prContext = ctxParts.join("\n\n---\n\n");
      // toolWindows declared at outer scope below; collect here.
      for (let gi = 0; gi < plan.goals.length; gi++) {
        const goal = plan.goals[gi];
        const t0 = performance.now();
        const startMs = Math.max(0, Math.round(t0 - runStart));
        const goalStartedAtWall = Date.now();
        logLine(chalk.cyan("▶"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any);
        let result: Awaited<ReturnType<typeof runGoal>>;
        try {
          result = await runGoal(page, goal, prContext, cdpEndpoint);
        } catch (e) {
          result = { outcome: "failure", note: (e as Error).message.split("\n")[0], actions: [], bbox: undefined };
        }
        const endMs = Math.max(startMs + 50, Math.round(performance.now() - runStart));
        // Convert each tool-call's wall-clock `startedAt` into an active
        // window in raw-video timeline terms. Span 2.5s per call so the
        // viewer can actually see what happened; the trim planner keeps
        // non-active agent-thinking gaps between them bounded.
        for (let ai = 0; ai < result.actions.length; ai++) {
          const a = result.actions[ai];
          if (!a.startedAt) continue;
          const windowStart = startMs + (a.startedAt - goalStartedAtWall);
          const next = result.actions[ai + 1];
          const nextStart = next?.startedAt ? startMs + (next.startedAt - goalStartedAtWall) : windowStart + 2500;
          const windowEnd = Math.min(nextStart, windowStart + 2800);
          if (windowEnd > windowStart) {
            toolWindows.push({
              startMs: Math.max(0, windowStart),
              endMs: windowEnd,
              kind: a.kind,
              input: a.value || a.target,
              result: a.result,
            });
          }
        }
        let screenshotPath: string | undefined;
        try {
          const p = path.join(shotsDir, `${goal.id}.png`);
          await page.screenshot({ path: p, fullPage: false });
          screenshotPath = p;
        } catch {}
        // Persist the full agent trace (tool inputs + truncated results)
        // per goal so we can debug why the agent over-explored after the
        // fact. Without this, stream-json output is lost at process exit.
        try {
          await writeFile(
            path.join(runDir, `agent-trace-${goal.id}.json`),
            JSON.stringify({ goal, outcome: result.outcome, note: result.note, actions: result.actions }, null, 2),
          );
        } catch {}
        events.push({
          stepId: goal.id,
          description: goal.intent,
          kind: "intent",
          importance: goal.importance ?? "normal",
          startMs,
          endMs,
          outcome: result.outcome,
          error: result.outcome === "failure" ? result.note : undefined,
          notes: result.note,
          screenshotPath,
          bbox: result.bbox,
        });
        if (result.outcome === "success") {
          logLine(chalk.green("✓"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any, result.note ?? "");
        } else {
          logLine(chalk.red("✗"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any, result.note ?? "");
        }
        // Small dwell between goals so the video has a visible pause between beats.
        await page.waitForTimeout(800);
      }
      // Tail dwell for editor to hold on the final goal's result.
      await page.waitForTimeout(1500);
    } else {
    // LEGACY STEP-BASED PATH — only used when claude.md ships a pre-baked
    // step-based plan (no goals). New plans always use goals.
    // If the first plan step is also a navigate to the same start URL, skip
    // the duplicate hop — setup may have already moved us to a different URL.
    const legacySteps = plan.steps ?? [];
    const first = legacySteps[0];
    const firstIsDupNav = first?.kind === "navigate" && (!first.target || first.target === plan.startUrl);
    const stepsToRun = firstIsDupNav ? legacySteps.slice(1) : legacySteps;
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
    } // end legacy step branch
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
    toolWindows: toolWindows.length ? toolWindows : undefined,
  };
  await writeFile(artifacts.eventsJsonPath, JSON.stringify({ plan, events, startedAt, finishedAt, totalMs, toolWindows: artifacts.toolWindows }, null, 2));
  if (artifacts.toolWindows?.length) {
    console.log(chalk.dim(`  tool windows: ${artifacts.toolWindows.length} (per-tool-call active spans for editor trim)`));
    const byKind: Record<string, number> = {};
    for (const tw of artifacts.toolWindows) byKind[tw.kind] = (byKind[tw.kind] ?? 0) + 1;
    const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(chalk.dim(`     ${breakdown}`));
  }
  await writeFile(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
  return artifacts;
}
