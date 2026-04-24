---
name: Taskpad
viewport: 720x720
---

## URL
http://localhost:4173

## Focus
A lightweight todo app called **Taskpad**. This PR adds **due dates**:
- A date input on the new-task form, next to the priority selector.
- Each task now renders a due-date badge: `Nd overdue` (red) for past dates,
  `today` (amber, bold) for today's date, `tomorrow` / `in Nd` (blue) for the
  next week, or a short `MM-DD` label beyond that.
- A new **Today** filter in the filter bar, alongside All / Active / Done / High.
- The footer stats now include an `N overdue` count when any active task is late.

Please thoroughly validate:
- Adding a task with and without a due date — both paths should persist.
- The due-date badge renders with the correct class (overdue / today / soon / none)
  for the date the user picked.
- The **Today** filter shows **tasks due today**, not tomorrow, not yesterday.
  (Off-by-one errors in date comparisons are an easy way to ship this broken.)
- The overdue count in the stats footer increments when a task goes overdue
  and decrements when it's completed.
- Existing flows still work: adding by priority, toggling done, every filter,
  deleting, clearing completed, toast confirmations, empty-state copy.

## Setup
No auth required. The app is a single static page served locally.

## Selectors
Prefer `data-testid` attributes:
- `new-task-input`, `new-task-priority`, `new-task-due-date`, `add-task`
- `filters` container, buttons inside match `[data-filter="all"]`, `[data-filter="active"]`, `[data-filter="done"]`, `[data-filter="high"]`, `[data-filter="today"]`
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`, `due-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `toast`

## Test Plan

```json
{
  "name": "Taskpad feature review",
  "summary": "Priority filter + toasts regression sweep",
  "startUrl": "http://localhost:4173",
  "viewport": { "width": 720, "height": 720 },
  "steps": [
    { "id": "open", "kind": "navigate", "description": "Open Taskpad", "target": "http://localhost:4173", "importance": "normal" },
    { "id": "see-login", "kind": "assert-visible", "description": "Login gate appears", "target": "[data-testid=login-gate]" },
    { "id": "login-pw", "kind": "fill", "description": "Type the password", "target": "[data-testid=login-password]", "value": "hunter2" },
    { "id": "login-submit", "kind": "click", "description": "Sign in", "target": "[data-testid=login-submit]", "importance": "high" },
    { "id": "wait-loading", "kind": "wait", "description": "Wait while it signs us in", "value": "1400" },
    { "id": "see-app", "kind": "assert-visible", "description": "Main app loads", "target": "[data-testid=main-app]" },
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
    { "id": "stats-update", "kind": "assert-text", "description": "Stats reflect remaining tasks", "target": "[data-testid=stats]", "value": "done" },
    { "id": "high-survives-clear", "kind": "assert-text", "description": "High-priority rows must survive Clear completed", "target": "[data-testid=tasks]", "value": "Ship Taskpad v0.1", "importance": "critical" },

    { "id": "dd-filter-all-again", "kind": "click", "description": "Back to the All filter to set up the due-date walk-through", "target": "[data-filter=all]" },
    { "id": "dd-overdue-visible", "kind": "assert-text", "description": "Seeded 'Write launch blog post' carries an overdue badge", "target": "[data-testid=tasks]", "value": "overdue", "importance": "high" },
    { "id": "dd-type-today", "kind": "fill", "description": "Type a task we intend to tag for today", "target": "[data-testid=new-task-input]", "value": "Prep standup notes" },
    { "id": "dd-pick-today", "kind": "script", "description": "Set the due-date input to today", "value": "const d=new Date(); const iso=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; const el=document.querySelector('[data-testid=new-task-due-date]'); el.value=iso; el.dispatchEvent(new Event('change'));" },
    { "id": "dd-submit-today", "kind": "click", "description": "Submit — expect a task dated today", "target": "[data-testid=add-task]", "importance": "high" },
    { "id": "dd-today-badge", "kind": "assert-text", "description": "The new task renders a 'today' badge", "target": "[data-testid=tasks]", "value": "today", "importance": "high" },
    { "id": "dd-filter-today", "kind": "click", "description": "Tap the new Today filter", "target": "[data-filter=today]", "importance": "critical" },
    { "id": "dd-today-shows-task", "kind": "assert-text", "description": "Today filter should surface the task we just dated for today", "target": "[data-testid=tasks]", "value": "Prep standup notes", "importance": "critical" },
    { "id": "dd-stats-overdue", "kind": "click", "description": "Back to All so we can read the stats footer", "target": "[data-filter=all]" },
    { "id": "dd-overdue-count", "kind": "assert-text", "description": "Stats footer surfaces the overdue count", "target": "[data-testid=stats]", "value": "overdue", "importance": "high" }
  ]
}
```
