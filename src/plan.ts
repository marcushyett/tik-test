import chalk from "chalk";
import type { Config, TestPlan } from "./types.js";
import { configToPromptContext } from "./config.js";
import { PLAN_TIMEOUT_MS } from "./timeouts.js";
import { runClaude, extractJson } from "./claude-cli.js";

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
    "shortLabel": string,        // SCANNABLE headline for the outro checklist — 3-5 words, ≤32 chars total. Examples: "Add task with due date", "Today filter shows today only", "Overdue badge after one day". NEVER duplicate the verbose intent — strip context, keep the verb + noun.
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
- DO NOT write a "log in" goal. Login is handled in a separate pre-test phase before any goal runs, using the credentials in the project setup. Your goals run AFTER the user is signed in, so write them as if the agent is already on the post-login app.
- Keep \`intent\` short (8-16 words). Keep \`success\` concrete and observable (6-14 words).
- \`shortLabel\` is for the on-video checklist a reviewer reads in <1s per goal. Strip articles, keep the verb + noun. ≤32 chars. NOT a sentence. Good: "Today filter shows today only". Bad: "Add a task due today and verify the Today filter shows it correctly".

INPUT SOURCES (the Context block below contains a mix; prioritise like this):
- "This PR (from PR title + description)" — the AUTHOR'S explicit guidance for what to test in this change. If they said "make sure to try X with empty input", that's your primary goal. If absent, fall back to the diff.
- "PR comments (teammate feedback)" — reviewer hints, sometimes authoritative ("you must trigger a fresh fetch first").
- "PR code diff" — what actually changed; use to cross-check the description and find risky surfaces the author forgot to mention.
- "Project setup (from tiktest.md)" — applies to every PR for this app. Use it for app context and to know login is handled. Do NOT generate goals based on tiktest.md content alone; this PR is what's being tested.

Context:
{{CONTEXT}}

Return ONLY the JSON.`;

export async function generatePlan(cfg: Config): Promise<TestPlan> {
  if (cfg.plan) {
    console.log(chalk.dim(`  using plan from config (${cfg.plan.goals?.length ?? 0} goals)`));
    return normalize(cfg.plan, cfg);
  }
  const prompt = PLAN_PROMPT.replace("{{CONTEXT}}", configToPromptContext(cfg));
  console.log(chalk.dim("  calling claude CLI to generate test plan…"));
  const raw = await runClaude({ prompt, timeoutMs: PLAN_TIMEOUT_MS, label: "plan", timeoutKnob: "TIK_PLAN_TIMEOUT_MS" });
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
  }
  return normalized;
}
