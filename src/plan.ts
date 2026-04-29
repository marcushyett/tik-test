import chalk from "chalk";
import type { Config, TestPlan } from "./types.js";
import { configToPromptContext } from "./config.js";
import { MAX_GOALS, PLAN_TIMEOUT_MS } from "./timeouts.js";
import { runClaude, extractJson } from "./claude-cli.js";

const PLAN_PROMPT = `You are generating a GOAL-BASED test plan for a web app. An autonomous AI agent will execute each goal by driving the browser — clicking, typing, reading the page — and decide HOW to achieve it based on what's actually on-screen. You DO NOT write selectors, URLs, or click sequences. You write GOALS and CONTEXT. Trust the agent.

**THE KEY OBJECTIVE**: show off the new feature working, OR surface that it's broken. That's it. Your plan either gives the reviewer confidence the feature ships, or shows them why it shouldn't. Anything that doesn't serve that is dead weight — cut it.

**FIRST: decide if this PR has ANY chance of affecting user-facing behaviour.** Read the PR title, description, comments, and diff. The bar is low — anything that could plausibly affect what a user sees or does on the app should run a regression pass on the affected UI. Specifically:
- A backend endpoint, query, or data-shape change → run a regression on a UI surface that consumes it (e.g. the screen that lists those records, the form that submits to that endpoint).
- A shared util / config / build setting that the app imports → run a smoke pass on a representative UI surface.
- A pure-docs change (README/CHANGELOG/.md), lockfile-only update with no app code, license / .gitignore / editor config / CI workflow YAML edit, or an unrelated subdirectory of a monorepo this app doesn't import from → genuine no-op. SKIP.

When (and ONLY when) the change is a genuine no-op, return: \`{ "noOp": true, "noOpReason": "<short reason, e.g. 'only README + lockfile changed'>" }\` — the other fields can be omitted. Default to running a plan if there's any plausible UI impact; do NOT skip just because the diff doesn't touch \`*.tsx\`. Backend changes that could break the UI they power are exactly the case we want regression tests for.

Output ONLY a single JSON object (no prose, no markdown fences):

{
  "noOp": boolean,               // true when the change cannot affect user-facing behaviour (see above)
  "noOpReason": string,          // when noOp=true, a short reason that names the change shape

  // The fields below are required when noOp=false; omit them when noOp=true.
  "name": string,
  "summary": string,
  "startUrl": string,            // MUST equal Context's Target URL exactly — preview root, no sub-path
  "viewport": { "width": number, "height": number },  // see VIEWPORT below — pick based on PR signals

  "goals": Array<{
    "id": string,                // short kebab-case id
    "intent": string,            // natural-language goal — describes WHAT to do, not which selectors to use
    "shortLabel": string,        // SCANNABLE headline for the outro checklist — 3-5 words, ≤32 chars total. Examples: "Add task with due date", "Today filter shows today only", "Overdue badge after one day". NEVER duplicate the verbose intent — strip context, keep the verb + noun.
    "success": string,           // observable condition, e.g. "Full-screen overlay is visible with counter showing 1 / N"
    "importance": "low"|"normal"|"high"|"critical"
  }>
}

VIEWPORT — pick the size that best showcases the change. Read the PR text, diff, and comments for signals:
- 540×960 (mobile portrait) — pick when the PR mentions mobile/phone/small-screen/touch, when the diff touches mobile-only surfaces (drawers, sheets, bottom-sheets, mobile nav), or when responsive breakpoints below ~768px are involved.
- 720×1024 (tablet portrait) — only when explicitly relevant; rare.
- 1080×800 (desktop) — default. Use for changes to desktop-first surfaces (sidebars, multi-column layouts, hover states, keyboard shortcuts) and when the PR gives no mobile signal.
Pick ONE viewport. If the change renders identically across sizes, pick the size most relevant to the PR's audience. Project-setup may pin a viewport in tiktest.md — only override that pin when the PR signal is unambiguous. These widths are chosen to render crisply in the reel canvas (no aliased downscaling), so don't substitute other widths.

GOAL-WRITING GUIDANCE:
1. **1-{{MAX_GOALS}} goals. Ruthlessly tight.** The video is a scroll-feed review under 60 seconds. One PRIMARY goal (the core flow of what this PR does), optionally up to {{MAX_SECONDARY_GOALS}} secondary goals (bug-probing variants — double-click, edge case, keyboard shortcut). If you can't justify an extra goal as essential, leave it out.
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
  const prompt = PLAN_PROMPT
    .replace("{{MAX_GOALS}}", String(MAX_GOALS))
    .replace("{{MAX_SECONDARY_GOALS}}", String(Math.max(0, MAX_GOALS - 1)))
    .replace("{{CONTEXT}}", configToPromptContext(cfg));
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
  // No-op verdict: plan generator decided the diff has no chance of
  // affecting user-facing behaviour. Trust the LLM's call here — pr.ts
  // skips cleanly with a "skipped" comment + neutral check-run instead
  // of inventing a goal against an unrelated change.
  if (plan.noOp) {
    return {
      name: plan.name || cfg.name || "tik-test (skipped — no-op)",
      summary: plan.summary || "",
      startUrl: plan.startUrl || cfg.url,
      viewport: plan.viewport || cfg.viewport || { width: 1280, height: 800 },
      noOp: true,
      noOpReason: plan.noOpReason?.trim() || "no user-facing impact",
    };
  }
  const normalized: TestPlan = {
    name: plan.name || cfg.name || "Feature review",
    summary: plan.summary || "",
    startUrl: plan.startUrl || cfg.url,
    viewport: plan.viewport || cfg.viewport || { width: 1280, height: 800 },
  };
  if (plan.goals && plan.goals.length > 0) {
    // Defensive cap — the prompt asks for ≤ MAX_GOALS but the LLM can ignore
    // it, especially on big PRs with many surfaces. Trim deterministically
    // (keep the first N) so a runaway plan can't blow past the job budget.
    const trimmed = plan.goals.slice(0, MAX_GOALS);
    if (trimmed.length < plan.goals.length) {
      console.log(chalk.yellow(`  plan returned ${plan.goals.length} goals, trimming to TIK_MAX_GOALS=${MAX_GOALS}`));
    }
    normalized.goals = trimmed.map((g, i) => ({
      ...g,
      id: g.id || `goal-${i + 1}`,
      importance: g.importance || "normal",
    }));
  }
  return normalized;
}
