# Taskpad

Taskpad is a lightweight todo list. Recent work has added a priority
selector on the new-task form, a High-priority filter, a search input,
a sort dropdown (Newest / Oldest / Priority / Alphabetical), and toast
confirmations when tasks change state.

When tik-test runs, please thoroughly validate:

- Adding tasks at each priority level (low / normal / high).
- Toggling tasks done/undone and the strike-through styling.
- Every filter (All / Active / Done / High priority) surfaces the correct subset.
- Search narrows the list correctly. Try uppercase AND lowercase variants of the same query.
- Each sort option visibly reorders the rows. "Priority" sort should put the most-important work AT THE TOP.
- Switching filter while a search is active keeps the search applied.
- Deleting a task removes it and the stats update.
- "Clear completed" removes only done tasks.

## URL

http://localhost:4173

## Setup

start: python3 -m http.server 4173

The `start:` prefix tells tik-test to run this command in the background
before the test phase. No auth required; the app is a single static page.

## Login

The login gate accepts any email plus the password `hunter2`.

## Selectors

Prefer `data-testid` attributes:

- `new-task-input`, `new-task-priority`, `add-task`
- `search-row`, `search-input`, `clear-search`
- `filters` container, buttons match `[data-filter="all"]`, `[data-filter="active"]`, `[data-filter="done"]`, `[data-filter="high"]`
- `sort-select` (option values: `newest`, `oldest`, `priority`, `alpha`)
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `no-match`, `toast`
