/**
 * Pre-test setup phase: read a repo's README for "TikTest" instructions and
 * translate them into concrete Playwright actions that leave the page in a
 * logged-in / test-ready state. Runs ONCE per PR run, before plan generation
 * and before the main test loop.
 *
 * The plan generator and the runner never see login — they assume they're
 * already inside the app.
 */
import { spawn } from "node:child_process";
import type { Page } from "playwright";
import chalk from "chalk";
import { SETUP_TIMEOUT_MS } from "./timeouts.js";

type SetupAction =
  | { action: "navigate"; url: string }
  | { action: "click"; target: string }
  | { action: "fill"; target: string; value: string }
  | { action: "press"; value: string }
  | { action: "wait"; ms?: number }
  | { action: "assert_visible"; target: string };

function runClaude(prompt: string, timeoutMs = SETUP_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`setup claude timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`setup claude exited ${code}: ${err}`));
    });
  });
}

function parseActions(reply: string): SetupAction[] {
  const trimmed = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`setup: couldn't find JSON array in reply: ${reply.slice(0, 200)}`);
  const obj = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(obj)) throw new Error(`setup: parsed JSON isn't an array`);
  return obj as SetupAction[];
}

function findLocator(page: Page, target: string) {
  const t = target.trim();
  if (/^(role=|text=|#|\.|\[|\/\/)/.test(t)) return page.locator(t).first();
  const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return page
    .getByRole("button", { name: re })
    .or(page.getByRole("link", { name: re }))
    .or(page.getByRole("textbox", { name: re }))
    .or(page.getByLabel(re))
    .or(page.getByPlaceholder(re))
    .or(page.getByTestId(t))
    .or(page.getByText(re))
    .first();
}

async function executeAction(page: Page, action: SetupAction, startUrl: string): Promise<void> {
  switch (action.action) {
    case "navigate": {
      const url = action.url.startsWith("http") ? action.url : new URL(action.url, startUrl).toString();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      // Let the page settle before any follow-up action — especially
      // server-action-rendered sign-in pages where the button appears a
      // tick after DOMContentLoaded.
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      return;
    }
    case "click": {
      const loc = findLocator(page, action.target);
      await loc.waitFor({ state: "visible", timeout: 15_000 });
      await loc.click({ timeout: 10_000 });
      await page.waitForTimeout(500);
      return;
    }
    case "fill": {
      const loc = findLocator(page, action.target);
      await loc.waitFor({ state: "visible", timeout: 15_000 });
      await loc.click({ timeout: 10_000 });
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await loc.type(action.value, { delay: 80 });
      return;
    }
    case "press": {
      await page.keyboard.press(action.value);
      await page.waitForTimeout(300);
      return;
    }
    case "wait": {
      await page.waitForTimeout(Math.max(200, Math.min(5000, action.ms ?? 1500)));
      return;
    }
    case "assert_visible": {
      const loc = findLocator(page, action.target);
      await loc.waitFor({ state: "visible", timeout: 15_000 });
      return;
    }
  }
}

/**
 * Execute the README's TikTest instructions on `page`. Translates the
 * free-form instructions into a JSON action list via a single Claude call,
 * then runs them sequentially. Throws if any action fails — the caller can
 * choose to abort or continue.
 */
export async function runSetup(page: Page, instructions: string, startUrl: string): Promise<void> {
  const trimmed = instructions.trim();
  if (!trimmed) return;

  console.log(chalk.dim("  running TikTest setup from README…"));

  const prompt = `You are converting a repo's README TikTest instructions into a concrete JSON list of Playwright actions. The browser starts at ${startUrl}. Follow the instructions EXACTLY — don't skip, don't improvise. The output of this phase leaves the page in a logged-in / test-ready state so a separate test agent can take over.

README TikTest instructions:
<<<
${trimmed}
>>>

Return ONLY a JSON array of actions (no prose, no markdown fences). Each action is one of:
- {"action":"navigate","url":"<absolute or relative URL>"}
- {"action":"click","target":"<visible text on the element, e.g. 'Preview Sign In'>"}
- {"action":"fill","target":"<label/placeholder/accessible name>","value":"<text>"}
- {"action":"press","value":"<key, e.g. Enter, Escape>"}
- {"action":"wait","ms":<milliseconds, 500-3000>}
- {"action":"assert_visible","target":"<visible text or selector>"}

Rules:
- Target values must be CONCRETE visible text quoted in the instructions or literal CSS/testid selectors. Do NOT translate descriptive prose into targets — if the instructions say "verify the dashboard is visible (e.g. sidebar or header)", the "(e.g. …)" is a HINT for a human reader, NOT a literal element label. Never create a target out of descriptive words like "the dashboard" or "the sidebar" unless those exact words are quoted as an element's visible label in the instructions.
- After a click that triggers a navigation/redirect, insert {"action":"wait","ms":1500} so the next page renders before the next action.
- Do NOT add trailing assert_visible verify-steps unless the instructions quote a specific element label. When in doubt, just end with a wait instead.
- The mandatory actions are the concrete ones (navigate, click, fill, press). Everything else is optional.

Return ONLY the JSON array.`;

  const raw = await runClaude(prompt);
  let actions: SetupAction[];
  try {
    actions = parseActions(raw);
  } catch (e) {
    throw new Error(`setup: couldn't parse claude's action list: ${(e as Error).message}`);
  }

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const detail = [
      (a as any).target,
      (a as any).url,
      (a as any).value,
      (a as any).ms ? `${(a as any).ms}ms` : "",
    ].filter(Boolean).join(" ");
    try {
      await executeAction(page, a, startUrl);
      console.log(chalk.dim(`     ✓ ${a.action}${detail ? " " + detail : ""}`));
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      // Non-destructive actions (assert_visible, wait) are verify-steps —
      // failing them doesn't mean setup failed, just that the optimistic
      // checkpoint wasn't there. The concrete actions above it may have
      // succeeded. Warn and continue. Destructive/navigational failures
      // abort — if we can't click the login button, there's no point
      // pretending the session is ready.
      if (a.action === "assert_visible" || a.action === "wait") {
        console.log(chalk.yellow(`     ! ${a.action}${detail ? " " + detail : ""} — ${msg.slice(0, 100)} (non-fatal, continuing)`));
        continue;
      }
      throw new Error(`setup failed at action ${i + 1}/${actions.length} (${a.action}${detail ? " " + detail : ""}): ${msg}`);
    }
  }
}
