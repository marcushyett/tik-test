---
name: tik-test
viewport: 900x760
---

## URL
http://localhost:4173

## Setup
start: python3 -m http.server 4173 --directory examples/todo-app

## Focus
This repo ships with **Taskpad**, a small todo app used as the dogfood target.
When `tik-test pr` runs on this repo, it will launch the bundled Taskpad and
exercise its priority picker, filters, and toasts. For a real app, a PR preview
URL (Vercel / Netlify) is auto-detected from the PR description or comments.

## Hard rules for the goal-agent (non-negotiable)

- **The goal agent MUST invoke the `claude` CLI directly (`spawn("claude", ...)`).** Not the Anthropic SDK. Not the Claude Agent SDK. Not direct API calls with an API key.
- **Reason**: tik-test compute must come out of the user's own Claude subscription/OAuth budget — the same auth they use for `claude` interactively. Using an SDK or raw API call would bill a separate API key and defeat the tool's entire economic model.
- The CLI is driven with `--input-format stream-json --output-format stream-json --verbose` so we can stream tool-use events for the narrator/editor.
- Browser tooling (snapshot / click / fill / screenshot) comes from **Playwright MCP** (`@playwright/mcp`), passed to the CLI via `--mcp-config`, with `--allowed-tools mcp__playwright` to sandbox the agent to browser actions only.
- Playwright MCP connects to the already-running Playwright browser via `--cdp-endpoint`, so video recording, cookies, and bypass headers stay intact while MCP drives.
- Do NOT reintroduce `@anthropic-ai/claude-agent-sdk` or `@anthropic-ai/sdk` as an agent dependency.

## Test Plan

```json
{
  "name": "Taskpad feature review",
  "summary": "Priority filter + toasts regression sweep",
  "startUrl": "http://localhost:4173",
  "viewport": { "width": 900, "height": 760 },
  "steps": [
    { "id": "open", "kind": "navigate", "description": "Open Taskpad", "target": "http://localhost:4173" },
    { "id": "see-counter", "kind": "assert-visible", "description": "Header shows the task counter", "target": "[data-testid=counter]" },
    { "id": "add-low", "kind": "fill", "description": "Type a low-priority task", "target": "[data-testid=new-task-input]", "value": "Water the plants" },
    { "id": "pick-low", "kind": "script", "description": "Pick 'Low' priority", "value": "document.querySelector('[data-testid=new-task-priority]').value='low'; document.querySelector('[data-testid=new-task-priority]').dispatchEvent(new Event('change'))" },
    { "id": "submit-low", "kind": "click", "description": "Submit — expect the green low badge", "target": "[data-testid=add-task]", "importance": "high" },
    { "id": "toast-added", "kind": "assert-visible", "description": "Toast confirms task added", "target": "[data-testid=toast].show", "importance": "high" },
    { "id": "add-high-1", "kind": "fill", "description": "Type a high-priority task", "target": "[data-testid=new-task-input]", "value": "Fix production bug" },
    { "id": "pick-high", "kind": "script", "description": "Pick 'High' priority", "value": "document.querySelector('[data-testid=new-task-priority]').value='high'; document.querySelector('[data-testid=new-task-priority]').dispatchEvent(new Event('change'))" },
    { "id": "submit-high", "kind": "click", "description": "Submit the high-priority task", "target": "[data-testid=add-task]", "importance": "critical" },
    { "id": "filter-high", "kind": "click", "description": "Tap the High priority filter", "target": "[data-filter=high]", "importance": "critical" },
    { "id": "only-high-visible", "kind": "assert-text", "description": "Only the high-priority task is listed", "target": "[data-testid=tasks]", "value": "Fix production bug", "importance": "high" },
    { "id": "filter-done", "kind": "click", "description": "Switch to the Done filter", "target": "[data-filter=done]" },
    { "id": "done-shows-seed", "kind": "assert-text", "description": "Seeded 'Review draft spec' shows under Done", "target": "[data-testid=tasks]", "value": "Review draft spec" },
    { "id": "filter-all", "kind": "click", "description": "Back to All", "target": "[data-filter=all]" },
    { "id": "toggle-high", "kind": "script", "description": "Complete the high-priority task", "value": "document.querySelectorAll('[data-testid=tasks] li .title').forEach(el => { if (el.textContent.includes('Fix production bug')) el.parentElement.querySelector('input[type=checkbox]').click(); })", "importance": "high" },
    { "id": "strike", "kind": "assert-visible", "description": "Completed task shows strike-through", "target": "[data-testid=tasks] li.done", "importance": "high" },
    { "id": "clear", "kind": "click", "description": "Clear completed tasks", "target": "[data-testid=clear-done]", "importance": "critical" },
    { "id": "stats-update", "kind": "assert-text", "description": "Stats reflect the remaining tasks", "target": "[data-testid=stats]", "value": "done" }
  ]
}
```
