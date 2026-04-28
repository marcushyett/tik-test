import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import chalk from "chalk";
import type { Goal, RunArtifacts, StepEvent, TestPlan } from "./types.js";
import { findFeature, isFeaturePageReady } from "./feature-finder.js";
import { runGoal } from "./goal-agent.js";

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


export interface RunOptions {
  plan: TestPlan;
  runDir: string;
  headed?: boolean;
  extraHTTPHeaders?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string; url?: string }>;
  storageStatePath?: string;
  /** Project-level context from the repo's tiktest.md (or fallback). Passed
   *  to each goal-agent so it can sign in autonomously when the page shows
   *  a login screen. Includes URL, login credentials, app description. */
  projectContext?: string;
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

/**
 * Pure RECORDER — no painted cursor, no ripples, no DOM mutation. Just
 * forwards mouse + click + keystroke events out via the
 * context-exposed `__tikRecord` callback so Remotion can render a
 * cinematic cursor + pan-zoom on top of the recorded video. The
 * page-painted cursor was retired because (a) it was duplicated for
 * each navigation, (b) Remotion can do a way slicker curved-path
 * cursor with click flashes, (c) targeted pan-zoom toward click bboxes
 * needs the same coord stream anyway.
 */
const INTERACTION_RECORDER_INIT = `
(() => {
  // Drop synthesized / programmatic clicks at (0,0) or in the top-left corner.
  // These are dispatched by frameworks during page bootstrap (focus
  // restoration, hidden a11y nodes, scrollIntoView side-effects) and have
  // no relationship to a real mouse interaction. Letting them through
  // produces a phantom cursor punch + zoom in the top-left of the video.
  const CORNER_PX = 5;
  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 33) return; // ~30Hz throttle keeps the stream small
    lastMove = now;
    if (e.clientX <= CORNER_PX && e.clientY <= CORNER_PX) return;
    try { window.__tikRecord && window.__tikRecord({ kind: 'move', x: e.clientX, y: e.clientY }); } catch {}
  }, true);
  document.addEventListener('click', (e) => {
    if (e.clientX <= CORNER_PX && e.clientY <= CORNER_PX) return;
    try { window.__tikRecord && window.__tikRecord({ kind: 'click', x: e.clientX, y: e.clientY }); } catch {}
  }, true);
  document.addEventListener('keydown', (e) => {
    try { window.__tikRecord && window.__tikRecord({ kind: 'key', x: 0, y: 0, key: e.key }); } catch {}
  }, true);
})();
`;

export async function runPlan({ plan, runDir, headed, extraHTTPHeaders, cookies, storageStatePath, projectContext, diff, comments, prTitle, prBody }: RunOptions): Promise<RunArtifacts> {
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
  // Recording starts the moment newContext({recordVideo}) returns. All
  // event + interaction timestamps below this line use this reference,
  // NOT runStart, because the raw video file's time-zero is recordingStart
  // — anything earlier (browser launch, CDP discovery, the 0.5-3s of
  // bootstrapping) doesn't exist in the recorded video. Using runStart
  // here was making clicks land 1-3s late in the rendered cursor.
  const recordingStart = performance.now();
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
  // Mouse + click + keystroke stream from the page, forwarded into the
  // runner via context.exposeFunction so it survives navigations. Times
  // are normalised to runStart so they line up with the events[] timeline
  // that drives the trim plan.
  const interactions: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }> = [];
  await context.exposeFunction("__tikRecord", (data: { kind: "move" | "click" | "key"; x: number; y: number; key?: string }) => {
    interactions.push({ ts: Math.max(0, Math.round(performance.now() - recordingStart)), ...data });
  });
  await context.addInitScript(INTERACTION_RECORDER_INIT);
  await context.addInitScript(BROKEN_IMAGE_FALLBACK);
  const page = await context.newPage();

  const events: StepEvent[] = [];
  const logLine = (label: string, step: { description: string }, extra = "") => {
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

    // Pre-test sign-in pass. Login isn't a "goal" — it doesn't count
    // toward the 1-3 visible goals or the outro checklist, and it
    // doesn't get filmed as a tested behaviour. But if tiktest.md
    // mentions credentials, we still need to be past any auth gate
    // before the real goals run. Use a goal-agent with a fixed,
    // narrow intent: log in if needed, otherwise do nothing.
    if (projectContext && projectContext.trim()) {
      const loginGoal: Goal = {
        id: "_login",
        intent:
          "If the current page shows a sign-in / login / authentication screen, sign in using the credentials in the CONTEXT below, then stop. " +
          "If the page is already past auth (you can see the app's main content), do nothing and emit OUTCOME: success — already authenticated. " +
          "DO NOT explore the app, DO NOT test any feature, DO NOT click around. Sign in only.",
        shortLabel: "Sign in",
        importance: "high",
      };
      logLine(chalk.dim("◦"), { id: "_login", kind: "intent", description: "pre-test sign-in", importance: "low" } as any);
      try {
        const loginResult = await runGoal(page, loginGoal, projectContext.trim(), cdpEndpoint);
        if (loginResult.outcome === "failure") {
          console.log(chalk.yellow(`  ! login phase reported failure but continuing — goals may still work if no auth required: ${loginResult.note?.slice(0, 100)}`));
        } else {
          console.log(chalk.dim(`  ✓ pre-test sign-in: ${loginResult.note?.slice(0, 80)}`));
        }
      } catch (e) {
        console.log(chalk.yellow(`  ! login phase crashed but continuing: ${(e as Error).message.split("\n")[0]}`));
      }
      // After login, the app likely redirected to a dashboard. Re-navigate
      // to the plan's start URL so the first goal begins from the canonical
      // entry point, not wherever auth dropped us.
      const postLoginUrl = page.url();
      try {
        const samePage = new URL(postLoginUrl).pathname === new URL(plan.startUrl).pathname;
        if (!samePage) {
          console.log(chalk.dim(`  returning to ${new URL(plan.startUrl).pathname} after sign-in (was ${new URL(postLoginUrl).pathname})`));
          await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
          await settleMedia(page);
          await page.waitForTimeout(800);
        } else {
          await settleMedia(page);
        }
      } catch {}
    }

    // Feature-finder: if the start URL leaves us on a 404, sign-in, or
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

    // The autonomous goal-agent executes each goal end-to-end, figuring out
    // selectors and sequences on the fly. This is the only execution path —
    // plans are always goal-based now (the legacy scripted step path was
    // removed). If we somehow get a plan with no goals, fail fast.
    if (!plan.goals || plan.goals.length === 0) {
      throw new Error("plan has no goals — the goal-agent path is the only supported execution path. The plan generator must always emit goals.");
    }

    // Build the per-turn context once. Order so the most actionable info
    // is impossible to miss: project setup (so the agent knows how to log
    // in if needed), then reviewer notes, then PR metadata, then diff.
    const ctxParts: string[] = [];
    if (projectContext && projectContext.trim()) {
      ctxParts.push(
        `PROJECT SETUP (from the repo's tiktest.md — applies to every PR for this app. Login already happened in a separate pre-test phase, so you should be on the post-login app. This is here for context about what the app does and as a fallback if the session expires mid-goal):\n${projectContext.trim()}`,
      );
    }
    if (comments && comments.trim()) {
      ctxParts.push(
        `REVIEWER NOTES (AUTHORITATIVE — these are instructions from people who already tested this PR. If any note says "do X before you assert Y", you MUST do X. Ignoring a reviewer note and declaring failure is itself a failure.):\n${comments.trim()}`,
      );
    }
    if (prTitle) ctxParts.push(`PR TITLE:\n${prTitle.trim()}`);
    if (prBody && prBody.trim()) ctxParts.push(`PR DESCRIPTION:\n${prBody.trim()}`);
    if (diff && diff.trim()) ctxParts.push(`CODE DIFF (truncated):\n${diff.trim()}`);
    const prContext = ctxParts.join("\n\n---\n\n");

    for (let gi = 0; gi < plan.goals.length; gi++) {
      const goal = plan.goals[gi];
      const t0 = performance.now();
      const startMs = Math.max(0, Math.round(t0 - recordingStart));
      const goalStartedAtWall = Date.now();
      logLine(chalk.cyan("▶"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any);
      let result: Awaited<ReturnType<typeof runGoal>>;
      try {
        result = await runGoal(page, goal, prContext, cdpEndpoint);
      } catch (e) {
        result = { outcome: "failure", note: (e as Error).message.split("\n")[0], actions: [], bbox: undefined };
      }
      const endMs = Math.max(startMs + 50, Math.round(performance.now() - recordingStart));
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
        // For the on-video checklist. Falls back to a 32-char truncation
        // of the verbose intent if the planner skipped shortLabel; falls
        // back to a 60-char truncation of the long note if the agent
        // skipped SHORTNOTE. Both fallbacks are safety nets — the planner
        // / agent prompts demand these fields.
        shortLabel: goal.shortLabel?.trim() || goal.intent.replace(/\s+/g, " ").slice(0, 32),
        shortNote: result.shortNote?.trim() || result.note?.replace(/\s+/g, " ").slice(0, 60),
        screenshotPath,
        bbox: result.bbox,
      });
      if (result.outcome === "success") {
        logLine(chalk.green("✓"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any, result.note ?? "");
      } else if (result.outcome === "skipped") {
        // Distinct visual from failure — yellow ⏭ so the runner log makes
        // it clear this isn't a regression, just a goal the agent honestly
        // couldn't auto-verify (tier 4 of the verification hierarchy).
        logLine(chalk.yellow("⏭"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any, result.note ?? "");
      } else {
        logLine(chalk.red("✗"), { id: goal.id, kind: "intent", description: goal.intent, importance: goal.importance } as any, result.note ?? "");
      }
      // Small dwell between goals so the video has a visible pause between beats.
      await page.waitForTimeout(800);
    }
    // Tail dwell for editor to hold on the final goal's result.
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
    toolWindows: toolWindows.length ? toolWindows : undefined,
    interactions: interactions.length ? interactions : undefined,
  };
  await writeFile(artifacts.eventsJsonPath, JSON.stringify({ plan, events, startedAt, finishedAt, totalMs, toolWindows: artifacts.toolWindows }, null, 2));
  if (artifacts.interactions?.length) {
    await writeFile(path.join(runDir, "interactions.json"), JSON.stringify(artifacts.interactions, null, 2));
    const byKind: Record<string, number> = {};
    for (const it of artifacts.interactions) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(chalk.dim(`  interactions: ${artifacts.interactions.length} (${breakdown})`));
  }
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
