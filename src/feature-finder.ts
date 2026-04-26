/**
 * Runtime feature-finder: when the plan's startUrl lands on a 404 or an
 * irrelevant dashboard, tik-test has no way to recover on its own — every
 * subsequent selector-based step fails because it's looking at the wrong
 * page. This module runs a ONE-shot Claude call with the current page
 * state + the PR diff and asks "navigate from here to where this feature
 * lives". Claude returns a short JSON action list; we execute it; then
 * the regular plan takes over against a correctly-positioned page.
 */
import { FEATURE_FINDER_TIMEOUT_MS } from "./timeouts.js";
import { runClaude } from "./claude-cli.js";
import type { Page } from "playwright";
import chalk from "chalk";
import type { TestPlan } from "./types.js";

type FinderAction =
  | { action: "click"; target: string }
  | { action: "wait"; ms?: number };

interface PageSnapshot {
  url: string;
  title: string;
  navItems: string[];
  buttons: string[];
  bodyExcerpt: string;
}

async function snapshot(page: Page): Promise<PageSnapshot> {
  const url = page.url();
  let title = "";
  try { title = await page.title(); } catch {}
  const elements = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLElement>('a, [role="link"], [role="menuitem"]'));
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"]'));
    const name = (el: HTMLElement) => (el.getAttribute("aria-label") || el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const visible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight + 800;
    };
    return {
      navItems: links.filter(visible).map(name).filter(Boolean).slice(0, 40),
      buttons: btns.filter(visible).map(name).filter(Boolean).slice(0, 30),
    };
  });
  let bodyExcerpt = "";
  try { bodyExcerpt = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 800); } catch {}
  return { url, title, ...elements, bodyExcerpt };
}

/** True when the page is 404, still on sign-in, or visibly blank. */
export async function isFeaturePageReady(page: Page): Promise<{ ready: boolean; reason?: string }> {
  let text = "";
  try { text = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 2000); } catch {}
  const url = page.url();
  if (/\/sign[-_]?in|\/login|\/auth(\/|$)/i.test(url)) return { ready: false, reason: "still on sign-in page" };
  if (/\b(404|page not found|not found)\b/i.test(text.slice(0, 600))) return { ready: false, reason: "404/not-found page" };
  if (text.trim().length < 60) return { ready: false, reason: "page is blank" };
  return { ready: true };
}

function parseActions(reply: string): FinderAction[] {
  const trimmed = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(obj) ? (obj as FinderAction[]) : [];
  } catch { return []; }
}

function findLocator(page: Page, target: string) {
  const t = target.trim();
  if (/^(role=|text=|#|\.|\[|\/\/)/.test(t)) return page.locator(t).first();
  const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return page
    .getByRole("link", { name: re })
    .or(page.getByRole("button", { name: re }))
    .or(page.getByRole("menuitem", { name: re }))
    .or(page.getByRole("tab", { name: re }))
    .or(page.getByText(re))
    .first();
}

async function exec(page: Page, a: FinderAction, _startUrl: string): Promise<void> {
  switch (a.action) {
    case "click": {
      const loc = findLocator(page, a.target);
      await loc.waitFor({ state: "visible", timeout: 8_000 });
      await loc.click({ timeout: 8_000 });
      await page.waitForTimeout(500);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      return;
    }
    case "wait": {
      await page.waitForTimeout(Math.max(200, Math.min(3_000, a.ms ?? 800)));
      return;
    }
  }
}

/**
 * Recover from a bad starting position by asking Claude to navigate to the
 * feature under test. Returns true if we're on a page Claude believed to
 * be relevant; false if we gave up.
 */
export async function findFeature(
  page: Page,
  plan: TestPlan,
  diff: string | undefined,
  reason: string,
): Promise<boolean> {
  console.log(chalk.yellow(`  feature-finder: ${reason} — asking Claude to navigate to the feature…`));

  // From whatever page we're on, always try going home first so Claude can
  // see the app's full nav. Costs ~1 extra navigation but gives the finder
  // a consistent starting point.
  try {
    await page.goto(plan.startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  } catch {}

  const state = await snapshot(page);

  const prompt = `You are helping a test runner navigate to a feature in a web app. The runner ended up on the wrong page and can't run its tests here. Find the feature, click your way there, and return the minimum steps needed.

FEATURE WE WANT TO TEST:
Plan name: ${plan.name}
Plan summary: ${plan.summary}

CURRENT PAGE:
URL: ${state.url}${state.title ? "\nTitle: " + state.title : ""}

Visible sidebar / nav links:
${state.navItems.length ? state.navItems.map((n, i) => `  [${i}] ${JSON.stringify(n)}`).join("\n") : "  (none)"}

Visible buttons / tabs:
${state.buttons.length ? state.buttons.map((n, i) => `  [${i}] ${JSON.stringify(n)}`).join("\n") : "  (none)"}

Body text excerpt:
${state.bodyExcerpt || "(empty)"}

PR DIFF (partial — look here for route paths, page component names, nav additions):
${(diff || "").slice(0, 4000)}

Reply with ONLY a JSON array of up to 5 actions:
- {"action":"click","target":"<exact visible text from nav/buttons above>"}
- {"action":"wait","ms":<800-2500>}

Rules:
- Navigate by CLICKING visible nav elements like a user would. You do NOT have a \`navigate\` action — URL guesses are not allowed (they 404 because real routes have org prefixes, route groups, etc that aren't visible in the diff).
- Target values MUST match one of the visible names above verbatim.
- If the feature is deep (sidebar → submenu → tab), chain the clicks.
- Insert a short \`wait\` between clicks when the target area needs to load (e.g. after opening a section before clicking something inside it).
- If you truly don't know where the feature lives, return an empty array [].

Return ONLY the JSON array.`;

  let reply: string;
  try {
    reply = await runClaude({ prompt, timeoutMs: FEATURE_FINDER_TIMEOUT_MS, label: "feature-finder" });
  } catch (e) {
    console.log(chalk.yellow(`    finder claude call failed: ${(e as Error).message.split("\n")[0]}`));
    return false;
  }

  const actions = parseActions(reply);
  if (actions.length === 0) {
    console.log(chalk.yellow(`    finder returned no actions — giving up gracefully (plan will run against ${state.url})`));
    return false;
  }

  for (const a of actions) {
    try {
      await exec(page, a, plan.startUrl);
      const detail = (a as any).target ?? (a as any).url ?? ((a as any).ms ? `${(a as any).ms}ms` : "");
      console.log(chalk.dim(`    ✓ ${a.action}${detail ? " " + detail : ""}`));
    } catch (e) {
      const detail = (a as any).target ?? (a as any).url ?? "";
      console.log(chalk.yellow(`    ✗ ${a.action}${detail ? " " + detail : ""} — ${(e as Error).message.split("\n")[0]}`));
      break;
    }
  }

  const again = await isFeaturePageReady(page);
  return again.ready;
}
