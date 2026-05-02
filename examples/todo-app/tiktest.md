# Taskpad

Taskpad is a lightweight, single-page todo list. The whole app is one
self-contained `index.html`. There's a login gate that accepts any
email plus the password `hunter2`, then a main view with three things:

- A new-task form (text input + priority dropdown + Add button).
- A filter bar (All / Active / Done / High priority / Today) plus a
  search input and a sort dropdown.
- A list of tasks with checkboxes, priority badges, per-row pin and
  delete buttons, and clickable inline-editable titles. Pinned tasks
  always sort to the top. Footer shows counts plus a "Clear completed"
  button.

## Login

Any email plus the password `hunter2`.

## Local dev

The bundled demo serves at http://localhost:4173 via:

start: python3 -m http.server 4173

(In CI for a real consumer repo, the preview URL is auto-detected from
the `deployment_status` event. The localhost URL above is only relevant
when running the demo locally.)

## Selectors

Prefer `data-testid` attributes:

- `new-task-input`, `new-task-priority`, `add-task`
- `search-row`, `search-input`, `clear-search`
- `filters` container; buttons match `[data-filter="all"]`,
  `[data-filter="active"]`, `[data-filter="done"]`,
  `[data-filter="high"]`
- `sort-select` (option values: `newest`, `oldest`, `priority`, `alpha`)
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `pin-<id>`, `del-<id>`,
  `title-<id>` (click to edit), `title-edit-<id>` (the inline input)
- `stats`, `counter`, `clear-done`, `empty`, `no-match`, `toast`
