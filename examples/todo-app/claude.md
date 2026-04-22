---
name: Taskpad
viewport: 900x760
---

## URL
http://localhost:4173

## Focus
A lightweight todo app called **Taskpad**. Recent work added:
- A priority selector (low / normal / high) on the new-task form.
- A "High priority" filter in the filter bar.
- A toast confirmation when tasks are added, completed or cleared.
- An empty-state message when no tasks match the current filter.

Please thoroughly validate:
- Adding tasks at each priority level (low / normal / high).
- Toggling tasks done/undone and the strike-through styling.
- Every filter (All / Active / Done / High priority) surfaces the correct subset.
- Deleting a task removes it and the stats update.
- "Clear completed" removes only done tasks.
- Empty-state copy appears when appropriate (e.g. filter to "Done" with nothing done).

## Setup
No auth required. The app is a single static page served locally.

## Selectors
Prefer `data-testid` attributes:
- `new-task-input`, `new-task-priority`, `add-task`
- `filters` container, buttons inside match `[data-filter="all"]`, `[data-filter="active"]`, `[data-filter="done"]`, `[data-filter="high"]`
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `toast`

## Test Plan

```json
{
  "name": "Taskpad feature review",
  "summary": "Priority filter + toasts regression sweep",
  "startUrl": "http://localhost:4173",
  "viewport": { "width": 1280, "height": 800 },
  "steps": [
    { "id": "open", "kind": "navigate", "description": "Open Taskpad", "target": "http://localhost:4173", "importance": "normal" },
    { "id": "see-counter", "kind": "assert-visible", "description": "Header shows the task counter", "target": "[data-testid=counter]" },
    { "id": "add-low", "kind": "fill", "description": "Type a low-priority task", "target": "[data-testid=new-task-input]", "value": "Water the plants" },
    { "id": "pick-low", "kind": "script", "description": "Pick 'Low' priority", "value": "document.querySelector('[data-testid=new-task-priority]').value='low'; document.querySelector('[data-testid=new-task-priority]').dispatchEvent(new Event('change'))" },
    { "id": "submit-low", "kind": "click", "description": "Submit — expect green low badge", "target": "[data-testid=add-task]", "importance": "high" },
    { "id": "toast-added", "kind": "assert-visible", "description": "Toast confirms task added", "target": "[data-testid=toast].show", "importance": "high" },
    { "id": "add-high-1", "kind": "fill", "description": "Type a high-priority task", "target": "[data-testid=new-task-input]", "value": "Fix production bug" },
    { "id": "pick-high", "kind": "script", "description": "Pick 'High' priority", "value": "document.querySelector('[data-testid=new-task-priority]').value='high'; document.querySelector('[data-testid=new-task-priority]').dispatchEvent(new Event('change'))" },
    { "id": "submit-high", "kind": "click", "description": "Submit the high-priority task", "target": "[data-testid=add-task]", "importance": "critical" },
    { "id": "filter-high", "kind": "click", "description": "Tap the 'High priority' filter", "target": "[data-filter=high]", "importance": "critical" },
    { "id": "only-high-visible", "kind": "assert-text", "description": "Only the high-priority task is listed", "target": "[data-testid=tasks]", "value": "Fix production bug", "importance": "high" },
    { "id": "filter-done", "kind": "click", "description": "Switch to the Done filter", "target": "[data-filter=done]" },
    { "id": "done-shows-seed", "kind": "assert-text", "description": "Seeded 'Review draft spec' shows under Done", "target": "[data-testid=tasks]", "value": "Review draft spec" },
    { "id": "filter-all", "kind": "click", "description": "Back to All", "target": "[data-filter=all]" },
    { "id": "toggle-high", "kind": "script", "description": "Complete the high-priority task", "value": "document.querySelectorAll('[data-testid=tasks] li .title').forEach(el => { if (el.textContent.includes('Fix production bug')) el.parentElement.querySelector('input[type=checkbox]').click(); })", "importance": "high" },
    { "id": "strike", "kind": "assert-visible", "description": "Completed task shows strike-through", "target": "[data-testid=tasks] li.done", "importance": "high" },
    { "id": "clear", "kind": "click", "description": "Clear completed tasks", "target": "[data-testid=clear-done]", "importance": "critical" },
    { "id": "stats-update", "kind": "assert-text", "description": "Stats reflect remaining tasks", "target": "[data-testid=stats]", "value": "done" }
  ]
}
```
