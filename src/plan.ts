import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Config, TestPlan } from "./types.js";
import { configToPromptContext } from "./config.js";

const PLAN_PROMPT = `You are generating an end-to-end UI test plan for a web application.

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
    "value"?: string,                  // text for fill; key for press; ms for wait; text for assert-text
    "importance"?: "low"|"normal"|"high"|"critical",
    "optional"?: boolean
  }>
}

Guidance:
- Cover the main user flows AND explicit edge/failure cases for the focus areas.
- Mark critical/risky steps with importance "high" or "critical" so they're emphasised in the highlight reel.
- Prefer robust selectors: text=, role=, [data-testid], aria labels — avoid nth-child chains.
- For navigations, set target = absolute URL (use the startUrl host for relative paths).
- Include explicit assert-visible / assert-text steps to confirm success after actions.
- Aim for 8-16 steps for a focused feature review.

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
