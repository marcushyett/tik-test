---
name: tik-test
---

This is the **tik-test** source repo. tik-test is a generic GitHub Action / CLI
that posts AI-generated video reviews on PRs for any web app — this repo is
the action's source code, not a target app.

If you (Claude) are running `tik-test pr` against THIS repo as a self-test,
the workflow points at the bundled demo in `examples/todo-app/`, which has
its own `tiktest.md`. That's where target-app-specific config lives. This
file is for working ON tik-test itself.

## Hard rules for the goal-agent (non-negotiable)

- **The goal agent MUST invoke the `claude` CLI directly (`spawn("claude", ...)`).** Not the Anthropic SDK. Not the Claude Agent SDK. Not direct API calls with an API key.
- **Reason**: tik-test compute must come out of the user's own Claude subscription/OAuth budget — the same auth they use for `claude` interactively. Using an SDK or raw API call would bill a separate API key and defeat the tool's entire economic model.
- The CLI is driven with `--input-format stream-json --output-format stream-json --verbose` so we can stream tool-use events for the narrator/editor.
- Browser tooling (snapshot / click / fill / screenshot) comes from **Playwright MCP** (`@playwright/mcp`), passed to the CLI via `--mcp-config`, with `--allowed-tools mcp__playwright` to sandbox the agent to browser actions only.
- Playwright MCP connects to the already-running Playwright browser via `--cdp-endpoint`, so video recording, cookies, and bypass headers stay intact while MCP drives.
- Do NOT reintroduce `@anthropic-ai/claude-agent-sdk` or `@anthropic-ai/sdk` as an agent dependency.

## Hard rules for tik-test prompts (non-negotiable)

Every prompt the CLI sends to Claude — plan generation (`src/plan.ts`),
narrator (`src/timed-narration.ts`), tool-caption translator
(`src/single-video-editor.ts: translateToolCaptions`), goal-agent system
prompt (`src/goal-agent.ts`) — must be **completely domain-agnostic**.

- **No mentions of specific apps, products, features, or domains** that
  tik-test has been used against (e.g. taskpad, todo apps, CRMs, internal
  tooling, marketing sites). The same prompt is shipped to every consumer's
  PR, so anything that names a particular product is dead weight at best
  and misleading at worst.
- **Examples in prompts must be GENERIC placeholders**: "the new feature",
  "the primary action", "an edge-case input", `[data-testid=submit]`,
  `type "hello"`, etc. NOT real product nouns like "Theater Mode",
  "Inspiration page", "Water the plants", "Fix production bug".
- **Selectors and DOM hints belong in the consumer's `claude.md`, never in
  this repo's prompts.** The plan generator should let the agent discover
  the page via `browser_snapshot`; the narrator should describe what it
  sees, not what we expect to be there.
- **When you change a prompt**, audit the prompt for app-specific wording
  before committing. Run `grep -in "<product-name>" src/`. Anything that
  reads like a war story from a specific deployment is a bug.

If a future user opens an issue saying "tik-test feels weirdly tuned for
some other app", that almost always means a prompt has app-specific
language baked in and needs cleaning.

## Self-test target

The bundled demo for self-testing is `examples/todo-app/`. The workflow at
`.github/workflows/tik-test-taskpad.yml` uses `working-directory: examples/todo-app`
so the CLI reads that folder's `tiktest.md` (which IS allowed to be
domain-specific — it's the example consumer config). The sister workflow
`.github/workflows/tik-test-webapp.yml` covers the deployed `web/` reviewer
app via a signed bypass URL. For everything in the tik-test source tree
itself, see the rules above.
