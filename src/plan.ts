import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Config, TestPlan } from "./types.js";
import { configToPromptContext } from "./config.js";

const PLAN_PROMPT = `You are generating a GOAL-BASED test plan for a web app. An autonomous AI agent will execute each goal by driving the browser — clicking, typing, reading the page — and decide HOW to achieve it based on what's actually on-screen. You DO NOT write selectors, URLs, or click sequences. You write GOALS and CONTEXT. Trust the agent.

**THE KEY OBJECTIVE**: show off the new feature working, OR surface that it's broken. That's it. Your plan either gives the reviewer confidence the feature ships, or shows them why it shouldn't. Anything that doesn't serve that is dead weight — cut it.

Output ONLY a single JSON object (no prose, no markdown fences):

{
  "name": string,
  "summary": string,
  "startUrl": string,            // MUST equal Context's Target URL exactly — preview root, no sub-path
  "viewport": { "width": number, "height": number },
  "goals": Array<{
    "id": string,                // short kebab-case id
    "intent": string,            // natural-language goal — describes WHAT to do, not which selectors to use
    "success": string,           // observable condition, e.g. "Full-screen overlay is visible with counter showing 1 / N"
    "importance": "low"|"normal"|"high"|"critical"
  }>
}

GOAL-WRITING GUIDANCE:
1. **1-3 goals. Ruthlessly tight.** The video is a scroll-feed review under 60 seconds. One PRIMARY goal (the core flow of what this PR does), optionally up to TWO secondary goals (bug-probing variants — double-click, edge case, keyboard shortcut). If you can't justify a second or third goal as essential, leave it out.
2. **The primary goal is end-to-end.** It includes navigating to the feature AND exercising it in a single natural-language instruction. Don't split "navigate" and "use feature" into two goals — the agent will do both inside one goal.
3. **Let the diff drive WHAT.** Read the PR: what's new? what's the ONE thing a reviewer cares about most? That's your primary goal.
4. **READ THE REVIEWER COMMENTS and bake any testing advice into the goal.** If a commenter says "fresh discoveries worked" or "run X before you'll see Y" or "the legacy data is broken, trigger a new flow", your primary goal MUST incorporate that action. Skipping the reviewer's suggested setup is the #1 way plans end up testing broken state instead of the fixed state.
5. **Success conditions should describe what a USER would see** — a rendered grid, a toast, a new card appearing, a counter changing. Avoid success conditions that require JS/network inspection ("img src points at X") — those force the agent to debug instead of demo. Only use technical conditions when truly unavoidable.
6. **Goals are natural-language INSTRUCTIONS.** Good shape (generic, not tied to any specific app):
   - PRIMARY: "Open the new feature from the main nav, exercise the primary action it adds, and confirm the visible result."
   - PRIMARY with reviewer hint: "Follow the reviewer's setup step (e.g. trigger a fresh fetch / clear cached state), then confirm the newly-rendered items behave as the PR describes."
   - SECONDARY (optional): "Try the same flow with an edge-case input (empty / max-length / repeated press) and confirm it doesn't break."

   When you write the actual goal, replace the generic phrasing with the app's real surface (page names, button labels, etc.) — but ONLY using language a user would see on screen, never selectors or class names.
7. **importance tier.** Primary goal is "critical"; secondary is "high".

RULES (strict):
- \`startUrl\` MUST equal Context's Target URL EXACTLY — preview root, NO sub-path appended.
- DO NOT include click sequences, selectors, data-testids, CSS, or URL paths in goal text. Trust the agent.
- DO NOT write login/auth goals — the setup phase handles that.
- Keep \`intent\` short (8-16 words). Keep \`success\` concrete and observable (6-14 words).

Context:
{{CONTEXT}}

Return ONLY the JSON.`;

const OLD_PLAN_PROMPT_UNUSED = `[legacy step-based prompt removed — goal-based above]
You are generating an EXHAUSTIVE, EXPLORATORY UI test plan for a web application.

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
- \`startUrl\` MUST be EXACTLY the \`Target URL\` from Context — the preview root — with NO sub-path appended. Route groups, org prefixes, and other conventions vary per app; guessing a sub-path will 404 and strand the run.
- You get exactly ONE \`kind:"navigate"\` step at the very top of the plan, with no target (it re-navigates to startUrl). Any further navigation between pages MUST be a \`kind:"click"\` on a visible sidebar / tab / link — the test agent navigates like a user, it does not fabricate URLs. Do NOT emit \`kind:"navigate"\` with a target URL anywhere after step 1.
- If the diff shows a route path (e.g. a new \`app/.../page.tsx\`), treat it as a HINT about WHERE the feature lives, not as a URL to visit directly. Translate it into click steps ("Click 'X' in sidebar → click 'Y' tab") — the runner will find the real route via visible navigation.

Context:
{{CONTEXT}}

Return ONLY the JSON. LEGACY UNUSED.`;

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
    const staged = cfg.plan;
    console.log(chalk.dim(`  using plan from config (${staged.goals?.length ?? staged.steps?.length ?? 0} ${staged.goals ? "goals" : "steps"})`));
    return normalize(staged, cfg);
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
  const normalized: TestPlan = {
    name: plan.name || cfg.name || "Feature review",
    summary: plan.summary || "",
    startUrl: plan.startUrl || cfg.url,
    viewport: plan.viewport || cfg.viewport || { width: 1280, height: 800 },
  };
  if (plan.goals && plan.goals.length > 0) {
    normalized.goals = plan.goals.map((g, i) => ({
      ...g,
      id: g.id || `goal-${i + 1}`,
      importance: g.importance || "normal",
    }));
  } else if (plan.steps && plan.steps.length > 0) {
    normalized.steps = plan.steps.map((s, i) => ({
      ...s,
      id: s.id || `step-${i + 1}`,
      importance: s.importance || "normal",
    }));
  }
  return normalized;
}
