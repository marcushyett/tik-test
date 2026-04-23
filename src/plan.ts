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
   The plan should exercise every one of them in the order a user would. A
   diff-driven plan that misses the new code is a failure.
2. **Every interactive surface in the focus area should be clicked at least once.** Go beyond the one primary path.
3. **Repeat critical actions** — add the same kind of task 2-3x, toggle filters multiple times, click back-and-forth between tabs. Bugs hide in repetition.
4. **Try edge cases** — empty inputs, very long inputs, special characters, double-clicks, clicking the same button twice, navigating back/forward.
5. **Check counts and aggregates** after changes — if the UI shows "N/M done", assert the numbers are right after each relevant action.
6. **Regression-probe related features** that share code with the change (e.g. if the PR touches a filter, test ALL filters, not just the new one).
7. **Mark risky steps** with importance "high" or "critical" — the video editor slow-mos those.
8. **Plan for failure visibility** — include an assert immediately after any action whose correctness matters; if the assert fails, the video lands on it and narrates "oops".
9. **Aim for 15-28 steps.** A short plan is under-testing.

Selectors: prefer text=, role=, [data-testid]. Avoid nth-child chains.

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
