# Taskpad

Taskpad is a lightweight, single-page todo list. The whole app is one
self-contained `index.html`. There's a login gate that accepts any
email plus the password `hunter2`, then a main view with three things:

- A new-task form (text input + priority dropdown + Add button).
- A filter bar (All / Active / Done / High priority / Today) plus a
  search input and a sort dropdown.
- A list of tasks with checkboxes, priority badges, and per-row delete
  buttons. Footer shows counts plus a "Clear completed" button.

## URL

http://localhost:4173

## Setup

start: python3 -m http.server 4173

(local-dev only; in CI the preview URL is auto-detected.)

## Login

Any email plus the password `hunter2`.

## Selectors

Prefer `data-testid` attributes:

- `new-task-input`, `new-task-priority`, `add-task`
- `search-row`, `search-input`, `clear-search`
- `filters` container; buttons match `[data-filter="all"]`,
  `[data-filter="active"]`, `[data-filter="done"]`,
  `[data-filter="high"]`
- `sort-select` (option values: `newest`, `oldest`, `priority`, `alpha`)
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `no-match`, `toast`
