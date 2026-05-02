import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import chalk from "chalk";
import type { Goal, RunArtifacts, StepEvent, TestPlan } from "./types.js";
import { findFeature, isFeaturePageReady, snapshot } from "./feature-finder.js";
import { runGoal } from "./goal-agent.js";
import { replayDemo, type GoalReplay } from "./demo-replay.js";

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
  /** Optional sign-in button label declared in the consumer repo's
   *  tiktest.md frontmatter. When provided, the pre-test sign-in pass
   *  passes it through to the agent as a hint and the runner produces a
   *  more actionable diagnostic on failure. */
  expectedSignInButton?: string;
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
export const BROKEN_IMAGE_FALLBACK = `
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
export const INTERACTION_RECORDER_INIT = `
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
    // Also record the clicked element's bounding rect — Remotion uses this
    // alongside the post-click MutationObserver stream below to decide
    // whether pan-zoom should ride (mutations stay inside the click bbox)
    // or release (mutations landed OUTSIDE the click bbox, e.g. a toast
    // appeared in the corner, a counter at the top updated).
    try {
      const t = e.target;
      if (t && t.getBoundingClientRect && window.__tikRecordClickBbox) {
        const r = t.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          window.__tikRecordClickBbox({ x: r.left, y: r.top, width: r.width, height: r.height });
        }
      }
    } catch {}
  }, true);
  document.addEventListener('keydown', (e) => {
    try { window.__tikRecord && window.__tikRecord({ kind: 'key', x: 0, y: 0, key: e.key }); } catch {}
  }, true);
})();
`;

/**
 * MutationObserver page script — records the bounding rect of every
 * meaningful DOM change so the editor can detect "the page updated
 * somewhere OTHER than where you just clicked." That's the signal pan-
 * zoom uses to decide ride vs release on each click gap.
 *
 * Filters that keep the stream useful instead of noisy:
 *   - skip <script>, <style>, <meta>, <link> mutations (invisible)
 *   - skip zero-size and fully off-screen rects
 *   - throttle by node-position signature within a 200ms window so a
 *     long type-into-input flurry doesn't write 60 mutations per second
 *   - record on childList AND attributes (style/class/hidden/aria-*)
 *     because real UI updates often change classes more than they
 *     add nodes (e.g. "is-open", "is-success", visibility toggles)
 */
export const MUTATION_RECORDER_INIT = `
(() => {
  function isInteresting(node) {
    if (!node || node.nodeType !== 1) return false;
    const t = node.tagName;
    if (!t) return false;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'META' || t === 'LINK' || t === 'NOSCRIPT') return false;
    return true;
  }
  function reportRect(node) {
    try {
      if (!isInteresting(node)) return;
      const r = node.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return;
      if (r.bottom <= 0 || r.right <= 0) return;
      if (r.left >= (window.innerWidth || 0) || r.top >= (window.innerHeight || 0)) return;
      try {
        window.__tikRecordMutation && window.__tikRecordMutation({
          x: r.left, y: r.top, width: r.width, height: r.height,
        });
      } catch {}
    } catch {}
  }
  // Coalesce same-position mutations within a 200ms window so we don't
  // record a flurry per keystroke (input value attribute changes fire
  // mutations on the same input bbox dozens of times per second).
  const recent = new Map();
  function recordThrottled(node) {
    try {
      const r = node.getBoundingClientRect();
      const sig = node.tagName + ':' + Math.round(r.top) + ':' + Math.round(r.left);
      const now = performance.now();
      const last = recent.get(sig);
      if (last && now - last < 200) return;
      recent.set(sig, now);
      reportRect(node);
    } catch {}
  }
  function init() {
    try {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) recordThrottled(n);
          if (m.type === 'attributes' && m.target) recordThrottled(m.target);
        }
      }).observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-busy', 'data-state', 'data-open'],
      });
    } catch {}
  }
  if (document.readyState !== 'loading') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
`;

/**
 * Page-side TIME-TRAVEL BUFFER + FREEZE HELPER. Solves a class of
 * agent-loop bugs where the thing the agent is verifying is ephemeral:
 *
 *   - chat-bot replies that scroll off-screen as new messages arrive
 *   - spinners / loading flashes that complete during the snapshot RTT
 *   - toast notifications that fade within ~2s
 *   - success banners that auto-dismiss
 *
 * Without this, the agent takes a snapshot, the state is gone, the
 * agent retries, the next snapshot is also too late, and either the
 * agent loops or it incorrectly concludes the feature is broken.
 *
 * Two namespaces, both exposed on every page (survives navigations
 * because addInitScript runs before any page script):
 *
 *   window.__tikHistory — read-only buffer of the last 30s of DOM
 *     mutations, queryable by text / tag / testid / kind. The agent
 *     uses this via browser_evaluate to verify state that ALREADY
 *     happened ("did the bot say X at any point in the last 20s?").
 *
 *   window.__tikFreeze — pause / resume CSS animations + Web Animations
 *     API instances. The agent calls pause() before
 *     browser_take_screenshot to catch sub-second transitions, then
 *     resume() to let the page continue. This is the same recipe the
 *     agent's prompt already taught it to write inline; surfacing it as
 *     a global helper makes it one-liner.
 *
 * The buffer caps at 30s × ~60 mutations/s ≈ 1800 entries × ~500 bytes
 * = ~900KB. Trimmed on every push so memory never grows unbounded.
 */
const TIK_HISTORY_INIT = `
(() => {
  if (window.__tikHistory) return;
  const RING_MS = 30000;
  const MAX_TEXT_LEN = 240;
  const log = [];

  function trim() {
    const cutoff = performance.now() - RING_MS;
    while (log.length > 0 && log[0].ts < cutoff) log.shift();
  }
  function isInteresting(node) {
    if (!node || node.nodeType !== 1) return false;
    const t = node.tagName;
    if (!t) return false;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'META' || t === 'LINK' || t === 'NOSCRIPT' || t === 'HEAD') return false;
    return true;
  }
  function ancestorTestid(node) {
    let n = node;
    let depth = 0;
    while (n && n.getAttribute && depth < 8) {
      const v = n.getAttribute('data-testid');
      if (v) return v;
      n = n.parentNode;
      depth++;
    }
    return undefined;
  }
  function nodeInfo(node) {
    try {
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      const text = (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
      const a = node.getAttribute ? (node.getAttribute('aria-label') || node.getAttribute('aria-labelledby')) : '';
      return {
        tag: (node.tagName || 'unknown').toLowerCase(),
        testid: (node.getAttribute && node.getAttribute('data-testid')) || undefined,
        containerTestid: ancestorTestid(node),
        ariaLabel: a || undefined,
        role: (node.getAttribute && node.getAttribute('role')) || undefined,
        text: text || undefined,
        bbox: r ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : undefined,
      };
    } catch (e) { return { tag: 'unknown' }; }
  }
  function record(kind, node, extra) {
    if (!isInteresting(node)) return;
    log.push({ ts: performance.now(), kind, ...nodeInfo(node), ...(extra || {}) });
    trim();
  }
  function recordTextChange(target, oldValue, newValue) {
    const parent = target && target.parentNode;
    if (!isInteresting(parent)) return;
    log.push({
      ts: performance.now(),
      kind: 'text-changed',
      ...nodeInfo(parent),
      previousText: (oldValue || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN) || undefined,
    });
    trim();
  }
  function init() {
    try {
      new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'childList') {
            m.addedNodes.forEach((n) => record('added', n));
            m.removedNodes.forEach((n) => record('removed', n));
          } else if (m.type === 'attributes') {
            record('attr-changed', m.target, { changedAttr: m.attributeName, attrValue: m.target.getAttribute && m.target.getAttribute(m.attributeName) || undefined });
          } else if (m.type === 'characterData') {
            recordTextChange(m.target, m.oldValue, m.target.nodeValue);
          }
        }
      }).observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-busy', 'aria-live', 'data-state', 'data-open', 'data-loading', 'role'],
        characterData: true,
        characterDataOldValue: true,
      });
    } catch (e) {}
  }
  if (document.readyState !== 'loading') init();
  else window.addEventListener('DOMContentLoaded', init);

  // Public read-only API. The agent calls these via browser_evaluate.
  window.__tikHistory = {
    // Filter the buffer by any combination of fields. Returns oldest-first.
    //   text:           substring match, case-insensitive, on the entry's text content
    //   tag:            exact tag match (lowercased)
    //   testid:         element's own data-testid
    //   containerTestid: any ancestor's data-testid (within 8 levels)
    //   kind:           'added' | 'removed' | 'text-changed' | 'attr-changed'
    //   sinceMs:        only entries within this many ms of now (default 30000)
    find(query) {
      query = query || {};
      const sinceMs = typeof query.sinceMs === 'number' ? query.sinceMs : RING_MS;
      const cutoff = performance.now() - sinceMs;
      const ql = query.text ? String(query.text).toLowerCase() : null;
      const out = [];
      for (const e of log) {
        if (e.ts < cutoff) continue;
        if (ql && (!e.text || !e.text.toLowerCase().includes(ql))) continue;
        if (query.tag && e.tag !== String(query.tag).toLowerCase()) continue;
        if (query.testid && e.testid !== query.testid) continue;
        if (query.containerTestid && e.containerTestid !== query.containerTestid) continue;
        if (query.kind && e.kind !== query.kind) continue;
        out.push({ ...e, sinceNowMs: Math.round(performance.now() - e.ts) });
      }
      return out;
    },
    // Elements that appeared then disappeared within the window. Match by
    // tag + testid + first 80 chars of text. Useful for spinners, toasts,
    // loading states that flashed up and are now gone.
    transients(sinceMs) {
      const window_ms = typeof sinceMs === 'number' ? sinceMs : RING_MS;
      const cutoff = performance.now() - window_ms;
      const recent = log.filter((e) => e.ts >= cutoff);
      const added = recent.filter((e) => e.kind === 'added');
      const removed = recent.filter((e) => e.kind === 'removed');
      const sig = (e) => e.tag + '|' + (e.testid || '') + '|' + ((e.text || '').slice(0, 80));
      const pairs = [];
      for (const a of added) {
        const k = sig(a);
        const r = removed.find((x) => x.ts > a.ts && sig(x) === k);
        if (r) pairs.push({ ...a, addedAt: a.ts, removedAt: r.ts, durationMs: Math.round(r.ts - a.ts), sinceNowMs: Math.round(performance.now() - r.ts) });
      }
      return pairs;
    },
    // Quick stats — useful for debugging the agent's queries.
    stats() {
      return { entries: log.length, oldestSinceNowMs: log.length ? Math.round(performance.now() - log[0].ts) : 0, ringMs: RING_MS };
    },
  };

  // Page freeze helper. Pause all CSS animations + Web Animations API
  // instances; combined with browser_take_screenshot this catches
  // sub-second transitions (spinners, toast flashes, focus rings,
  // skeleton states). Always call resume() afterwards.
  window.__tikFreeze = {
    pause() {
      try { document.getAnimations().forEach((a) => { try { a.pause(); } catch (e) {} }); } catch (e) {}
      return performance.now();
    },
    resume() {
      try { document.getAnimations().forEach((a) => { try { a.play(); } catch (e) {} }); } catch (e) {}
    },
  };
})();
`;

export async function runPlan({ plan, runDir, headed, extraHTTPHeaders, cookies, storageStatePath, projectContext, diff, comments, prTitle, prBody, expectedSignInButton }: RunOptions): Promise<RunArtifacts> {
  await mkdir(runDir, { recursive: true });
  const videoDir = path.join(runDir, "video");
  await mkdir(videoDir, { recursive: true });
  const shotsDir = path.join(runDir, "screenshots");
  await mkdir(shotsDir, { recursive: true });

  // Snap viewport WIDTH to a canvas-friendly value (540, 720, 1080, 1920).
  // Reason: the Remotion canvas is 1080×1920 and the body recording is
  // rendered with objectFit:contain. If the recording's width doesn't
  // divide 1080 cleanly (e.g. 1280 → 1080 is 0.84×), the browser
  // bilinear-downsamples on every frame and ALL the page text looks
  // aliased even at zoom=1.0. {540, 720, 1080} give integer scales
  // (2×, 1.5×, 1×); 1920 maps to 1080 at exactly 9/16 — not integer
  // but a clean repeating fraction, and 1920×1080 is the realistic
  // 2026 desktop default (StatCounter: ~21.5% US share, top resolution).
  // Heights round to the nearest 8 for x264 chroma-subsampling alignment.
  const requested = plan.viewport ?? { width: 1920, height: 1080 };
  const snapWidth = (w: number): number => {
    if (w <= 600) return 540;    // mobile portrait
    if (w <= 900) return 720;    // tablet portrait
    if (w <= 1280) return 1080;  // narrow desktop / laptop
    return 1920;                 // wide desktop (realistic 2026 default)
  };
  const targetWidth = snapWidth(requested.width);
  // Preserve the agent's intended aspect ratio when scaling height.
  const targetHeight = Math.max(8, Math.round((requested.height * targetWidth / requested.width) / 8) * 8);
  const viewport = { width: targetWidth, height: targetHeight };
  if (viewport.width !== requested.width || viewport.height !== requested.height) {
    console.log(chalk.dim(`  viewport snapped: ${requested.width}×${requested.height} → ${viewport.width}×${viewport.height} (canvas-friendly)`));
  }
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
  // Click bbox stream — for each click event, the page also reports the
  // clicked element's getBoundingClientRect(). The editor uses this with
  // the mutations stream below to detect post-click DOM updates that
  // landed OUTSIDE the clicked element (toast appears far from the
  // button, counter at the top updates, items reorder elsewhere). When
  // such off-target mutations are detected, pan-zoom releases for that
  // gap so the viewer sees the full page instead of a held zoom on the
  // click site.
  const clickBboxes: Array<{ ts: number; x: number; y: number; width: number; height: number }> = [];
  await context.exposeFunction("__tikRecordClickBbox", (data: { x: number; y: number; width: number; height: number }) => {
    clickBboxes.push({ ts: Math.max(0, Math.round(performance.now() - recordingStart)), ...data });
  });
  // DOM mutation stream — every meaningful element mutation gets its
  // bounding rect reported here. Throttled page-side so a long type-into-
  // input flurry doesn't write 60 records per second.
  const mutations: Array<{ ts: number; x: number; y: number; width: number; height: number }> = [];
  await context.exposeFunction("__tikRecordMutation", (data: { x: number; y: number; width: number; height: number }) => {
    mutations.push({ ts: Math.max(0, Math.round(performance.now() - recordingStart)), ...data });
  });
  await context.addInitScript(INTERACTION_RECORDER_INIT);
  await context.addInitScript(MUTATION_RECORDER_INIT);
  await context.addInitScript(TIK_HISTORY_INIT);
  await context.addInitScript(BROKEN_IMAGE_FALLBACK);
  const page = await context.newPage();

  const events: StepEvent[] = [];
  // Pass-2 replay material — populated as each pass-1 goal completes if the
  // agent emitted STEPS. After pass 1 finishes we hand this to demo-replay
  // for a deterministic, paced re-run that becomes the actual final video.
  const goalReplays: GoalReplay[] = [];
  // Persisted storageState from the end of pass 1 — captures any login that
  // happened during the pre-test sign-in goal so pass 2 starts authenticated.
  let pass1StoragePath: string | undefined;
  // Login STEPS emitted by the pre-test sign-in agent. Pass 2 replays these
  // when its fresh browser lands on a login screen — the storageState
  // carryover only covers cookies + localStorage, so apps that store auth
  // in-memory (or behind a session-cookie that didn't get set) need a
  // re-login at replay time.
  let pass1LoginSteps: import("./types.js").DemoStep[] | undefined;
  const logLine = (label: string, step: { description: string }, extra = "") => {
    const pad = String(events.length + 1).padStart(2, "0");
    console.log(`  ${chalk.dim(pad)} ${label} ${chalk.bold(step.description)}${extra ? chalk.dim("  " + extra) : ""}`);
  };

  // Per-tool-call active-window hints from the agent — declared at function
  // scope so they survive the try block and reach the RunArtifacts builder.
  const toolWindows: Array<{ startMs: number; endMs: number; kind: string; input?: string; result?: string }> = [];

  try {
    // Always navigate to startUrl first so the setup phase has a valid page.
    // Distinguish "preview URL unreachable" (network error / DNS / 4xx on the
    // root) from "preview URL reached but sign-in UI was missing" — the two
    // failure modes need different fixes (#1 the URL is wrong / preview not
    // deployed yet; #2 the dev-auth UI doesn't exist on this preview).
    try {
      const resp = await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (resp && resp.status() >= 400) {
        throw new Error(
          `Preview URL ${plan.startUrl} responded ${resp.status()} on the root. ` +
          `If you're using the official Vercel GitHub integration this is usually transient; ` +
          `if you're using a hand-rolled deploy workflow, the registered URL might point at build logs ` +
          `(GitHub's deprecated 'target_url' alias) instead of the deployed app. ` +
          `In templates/workflows/vercel-preview.yml, prefer '(.environment_url // .target_url)' over '.target_url'.`
        );
      }
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(
        `Couldn't reach preview URL ${plan.startUrl}: ${msg.split("\n")[0]}\n\n` +
        `What this means: Playwright failed to load the root of the URL tik-test was given. ` +
        `It is NOT a sign-in / auth / "couldn't find dev login" failure — the agent never got a chance to look at the page.\n\n` +
        `Common causes:\n` +
        `  • The PR's preview deployment isn't actually ready yet, or the workflow timed out polling for it.\n` +
        `  • The URL the workflow registered points at build logs (vercel.com/.../build-logs) rather than the deployed app — check 'environment_url' vs 'target_url' on the GitHub Deployment status.\n` +
        `  • Vercel Deployment Protection is on but no automation-bypass secret was supplied.`
      );
    }
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
      const expectedBtnHint = expectedSignInButton
        ? ` The repo's tiktest.md declares the expected sign-in button label as: ${JSON.stringify(expectedSignInButton)}. ` +
          `Click that button (or one whose text matches) to start the dev-auth flow. ` +
          `If you cannot find a button with that label among the visible buttons, REPORT FAILURE — do not guess at Google / SSO paths.`
        : "";
      const loginGoal: Goal = {
        id: "_login",
        intent:
          "If the current page shows a sign-in / login / authentication screen, sign in using the credentials in the CONTEXT below, then stop. " +
          "If the page is already past auth (you can see the app's main content), do nothing and emit OUTCOME: success — already authenticated. " +
          "DO NOT explore the app, DO NOT test any feature, DO NOT click around. Sign in only." +
          expectedBtnHint,
        shortLabel: "Sign in",
        importance: "high",
      };
      logLine(chalk.dim("◦"), { id: "_login", kind: "intent", description: "pre-test sign-in", importance: "low" } as any);
      try {
        const loginResult = await runGoal(page, loginGoal, projectContext.trim(), cdpEndpoint);
        if (loginResult.outcome === "failure") {
          // Auth UI couldn't be driven — produce a diagnostic that names
          // (a) the page we landed on and (b) the visible buttons we
          // actually found. This distinguishes "page loaded but the
          // expected dev-auth button isn't here" from "preview URL
          // unreachable" (which fails earlier at page.goto above).
          let diag = "";
          try {
            const snap = await snapshot(page);
            const visible = snap.buttons.length ? snap.buttons.slice(0, 8).map((b) => JSON.stringify(b)).join(", ") : "(none visible)";
            const expected = expectedSignInButton
              ? `expected button matching ${JSON.stringify(expectedSignInButton)} not found`
              : `no button matched the credentials in tiktest.md`;
            diag = `\n    page: ${snap.url}\n    diagnosis: reached sign-in but ${expected}; visible buttons were: [${visible}]`;
          } catch {}
          console.log(chalk.yellow(`  ! login phase reported failure but continuing — goals may still work if no auth required: ${loginResult.note?.slice(0, 100)}${diag}`));
        } else {
          console.log(chalk.dim(`  ✓ pre-test sign-in: ${loginResult.note?.slice(0, 80)}`));
        }
        if (loginResult.steps?.length) {
          pass1LoginSteps = loginResult.steps;
          console.log(chalk.dim(`  ✓ login STEPS captured for pass 2 replay (${loginResult.steps.length} steps)`));
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
      const shortLabel = goal.shortLabel?.trim() || goal.intent.replace(/\s+/g, " ").slice(0, 32);
      const shortNote = result.shortNote?.trim() || result.note?.replace(/\s+/g, " ").slice(0, 60);
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
        shortLabel,
        shortNote,
        screenshotPath,
        bbox: result.bbox,
      });
      // Stash the agent's choreographed demo for pass 2 — but only for
      // outcomes the viewer should actually see replayed. Skipped goals
      // have no useful happy path to demonstrate; pass 2 silently drops
      // them so the final video stays focused on what actually works
      // (success) or what's clearly broken (failure).
      if (result.steps?.length && result.outcome !== "skipped") {
        goalReplays.push({
          goalId: goal.id,
          description: goal.intent,
          importance: goal.importance ?? "normal",
          shortLabel,
          shortNote,
          outcome: result.outcome,
          note: result.note,
          steps: result.steps,
        });
      }
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
    // Snapshot the post-pass-1 storageState (cookies + localStorage) BEFORE
    // closing the context. Pass 2 reuses this so any login that happened
    // during pass 1 carries over — without it, pass 2 would land on the
    // login page and find none of the labelled elements.
    try {
      pass1StoragePath = path.join(runDir, "pass1-storage.json");
      await context.storageState({ path: pass1StoragePath });
    } catch {
      pass1StoragePath = undefined;
    }
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

  // ── PASS 2 — DETERMINISTIC DEMO REPLAY.
  //
  // Pass 1 (above) is exploratory: the agent clicks fast, retries probes,
  // double-checks, sometimes loops. The recording shows all of that and
  // narration falls behind because there's no breathing room between
  // actions. Pass 2 takes the agent's STEPS output (a clean linear demo
  // PER goal — its own summary of what to show, with labels copied from
  // what it actually saw on screen) and replays them with fixed dwell
  // between actions. This recording is what becomes the final video.
  //
  // Falls back to pass-1 video if the agent didn't emit any STEPS (e.g.
  // every goal was skipped) or pass 2 itself fails for any reason.
  let finalVideoPath = rawVideoPath;
  let finalEvents = events;
  let finalToolWindows = toolWindows;
  let finalInteractions = interactions;
  let finalClickBboxes = clickBboxes;
  let finalMutations = mutations;
  if (goalReplays.length > 0) {
    try {
      const replay = await replayDemo({
        goals: goalReplays,
        loginSteps: pass1LoginSteps,
        runDir,
        startUrl: plan.startUrl,
        viewport,
        headed: !!headed,
        // Prefer the storageState we captured at the end of pass 1 (which
        // includes any in-test login). Fall back to the externally-supplied
        // one (CI runs with prebuilt auth) and finally to undefined (no auth).
        storageStatePath: pass1StoragePath ?? storageStatePath,
        cookies,
        extraHTTPHeaders,
      });
      finalVideoPath = replay.rawVideoPath;
      finalEvents = replay.events;
      finalToolWindows = replay.toolWindows;
      finalInteractions = replay.interactions;
      finalClickBboxes = replay.clickBboxes;
      finalMutations = replay.mutations;
      console.log(chalk.green(`  pass 2 replay used as final video (pass-1 recording kept at ${path.basename(rawVideoPath)} for debugging)`));
    } catch (e) {
      console.log(chalk.yellow(`  pass 2 replay failed (${(e as Error).message.split("\n")[0]}); falling back to pass-1 video`));
    }
  } else {
    console.log(chalk.dim(`  pass 2 skipped: no agent emitted STEPS (the prompt asks for them; older agent runs may not). Using pass-1 video.`));
  }

  const finishedAt = new Date().toISOString();
  const totalMs = Math.round(performance.now() - runStart);

  const artifacts: RunArtifacts = {
    runDir,
    rawVideoPath: finalVideoPath,
    eventsJsonPath: path.join(runDir, "events.json"),
    events: finalEvents,
    plan,
    startedAt,
    finishedAt,
    totalMs,
    toolWindows: finalToolWindows.length ? finalToolWindows : undefined,
    interactions: finalInteractions.length ? finalInteractions : undefined,
    clickBboxes: finalClickBboxes.length ? finalClickBboxes : undefined,
    mutations: finalMutations.length ? finalMutations : undefined,
  };
  await writeFile(artifacts.eventsJsonPath, JSON.stringify({ plan, events, startedAt, finishedAt, totalMs, toolWindows: artifacts.toolWindows }, null, 2));
  if (artifacts.interactions?.length) {
    await writeFile(path.join(runDir, "interactions.json"), JSON.stringify(artifacts.interactions, null, 2));
    const byKind: Record<string, number> = {};
    for (const it of artifacts.interactions) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(chalk.dim(`  interactions: ${artifacts.interactions.length} (${breakdown})`));
  }
  if (artifacts.clickBboxes?.length || artifacts.mutations?.length) {
    console.log(chalk.dim(`  page changes: ${artifacts.clickBboxes?.length ?? 0} click bboxes · ${artifacts.mutations?.length ?? 0} dom mutations (used for off-target zoom-release detection)`));
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
