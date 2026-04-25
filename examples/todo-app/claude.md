---
name: Taskpad
viewport: 720x720
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
start: python3 -m http.server 4173

(The line above tells tik-test to start the static server before running.
No auth required — the app is a single static page served locally.)

## Selectors
Prefer `data-testid` attributes:
- `new-task-input`, `new-task-priority`, `add-task`
- `filters` container, buttons inside match `[data-filter="all"]`, `[data-filter="active"]`, `[data-filter="done"]`, `[data-filter="high"]`
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `toast`

The login gate accepts any email + the password `hunter2`.

(No hand-written test plan — tik-test should generate one each run from the
focus above plus the PR diff. That's the realistic path: a maintainer
describes what changed and what's risky; the agent figures out how to
exercise it.)
