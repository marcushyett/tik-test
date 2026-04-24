import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Config, TestPlan } from "./types.js";
import { configToPromptContext } from "./config.js";

const PLAN_PROMPT = `You are generating an EXHAUSTIVE, EXPLORATORY UI test plan for a web application.

Your job is **to expose bugs**, not to prove the happy path works. A minimum-coverage
sanity pass is a failure of this task. Behave like a thorough QA engineer who clicks
through the whole surface, repeats actions, tries things in weird orders, and deliberately
probes edge cases.

Output ONLY a single JSON object (no prose, no markdown fences) matching:

{
  "name": string,
  "summary": string,
  "startUrl": string,
  "viewport": { "width": number, "height": number },
  "steps": Array<{
    "id": string,
    "kind": "navigate"|"click"|"fill"|"press"|"hover"|"wait"|"assert-visible"|"assert-text"|"screenshot"|"script",
    "description": string,            // concise, caption-ready, <=80 chars
    "target"?: string,                 // CSS/Playwright selector, URL for navigate, or "role=button[name=...]"
    "value"?: string,
    "importance"?: "low"|"normal"|"high"|"critical",
    "optional"?: boolean
  }>
}

PLAN GUIDANCE — follow all of these:
1. **If a code diff is provided, let it DRIVE the plan.** Identify the specific
   files, components, event handlers, selectors, and data-testids that changed.
   The plan should exercise every one of them. A diff-driven plan that misses
   the new code is a failure.
2. **Every user-visible surface the diff touches should be clicked at least once.** Go beyond the one primary path.
3. **Try 1-2 edge cases for critical actions** — click the same button twice, navigate back/forward, toggle a state off-then-on. Bugs hide in repetition, but don't pad the plan with repetitive clicks.
4. **Check counts and aggregates** after changes — if the UI shows "N/M done", assert the numbers are right after each relevant action.
5. **Mark risky steps** with importance "high" or "critical" — the video editor slow-mos those.
6. **Plan for failure visibility** — include an assert immediately after any action whose correctness matters; if the assert fails, the video lands on it and narrates "oops".
7. **NEVER use \`wait\` steps longer than 3000ms.** Cache revalidation, debounced refetches, etc. can be tested by asserting *after* the app settles naturally — don't burn 30 seconds of video waiting.
8. **Keep it tight: 12-18 steps total.** The output is a 60-90 second review video — 30-step plans produce 5-minute slogs that nobody watches. Prefer breadth of coverage over repetition.
9. **DO NOT plan any sign-in / login / auth steps.** A separate pre-test setup phase (driven by the repo's README TikTest section) handles all authentication before your plan runs. Start your plan from an already-logged-in state — go straight into exercising the diff's features.

Selectors: prefer text=, role=, [data-testid]. Avoid nth-child chains.

URL RULES (strict):
- \`startUrl\` MUST be EXACTLY the \`Target URL\` from Context — the preview root — with NO sub-path appended. Sub-path guesses are routinely wrong (route groups, /gruns/… org prefixes, etc) and leave the run stuck on 404.
- You get exactly ONE \`kind:"navigate"\` step at the very top of the plan, with no target (it re-navigates to startUrl). Any further navigation between pages MUST be a \`kind:"click"\` on a visible sidebar / tab / link — the test agent navigates like a user, it does not fabricate URLs. Do NOT emit \`kind:"navigate"\` with a target URL anywhere after step 1. Every extra in-page transition is a click.
- If the diff adds a route like \`app/gruns/inspiration/theater/page.tsx\`, that's a HINT about WHERE the feature lives, not a URL you should navigate to directly. Use the hint to describe the click path in your plan ("Click 'Inspiration' in sidebar → click 'Theater' button"), not to construct a URL.

Context:
{{CONTEXT}}

Return ONLY the JSON.`;

function runClaude(prompt: string, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err || out}`));
      resolve(out.trim());
    });
  });
}

function extractJson(text: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export async function generatePlan(cfg: Config): Promise<TestPlan> {
  if (cfg.plan) {
    console.log(chalk.dim(`  using plan from config (${cfg.plan.steps.length} steps)`));
    return normalize(cfg.plan, cfg);
  }
  const prompt = PLAN_PROMPT.replace("{{CONTEXT}}", configToPromptContext(cfg));
  console.log(chalk.dim("  calling claude CLI to generate test plan…"));
  const raw = await runClaude(prompt);
  const json = extractJson(raw);
  let plan: TestPlan;
  try {
    plan = JSON.parse(json) as TestPlan;
  } catch (e) {
    throw new Error(`Failed to parse claude plan output: ${(e as Error).message}\n---\n${raw.slice(0, 500)}`);
  }
  return normalize(plan, cfg);
}

function normalize(plan: TestPlan, cfg: Config): TestPlan {
  return {
    name: plan.name || cfg.name || "Feature review",
    summary: plan.summary || "",
    startUrl: plan.startUrl || cfg.url,
    viewport: plan.viewport || cfg.viewport || { width: 1280, height: 800 },
    steps: plan.steps.map((s, i) => ({
      ...s,
      id: s.id || `step-${i + 1}`,
      importance: s.importance || "normal",
    })),
  };
}
