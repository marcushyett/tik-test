# Taskpad

Taskpad is a lightweight, single-page todo list. The whole app is one
self-contained `index.html`. There's a login gate that accepts any
email plus the password `hunter2`, then a main view with three things:

- A new-task form (text input + priority dropdown + Add button).
- A filter bar (All / Active / Done / High priority / Today) plus a
  search input and a sort dropdown.
- A list of tasks with checkboxes, priority badges, and per-row delete
  buttons. Footer shows counts plus a "Clear completed" button.

## Login

Any email plus the password `hunter2`.

## Local dev

The bundled demo serves at http://localhost:4173 via:

start: node server.js

`server.js` is a tiny static-file + API server (no deps). It replaces the
old `python3 -m http.server` because the AI priority-hints feature needs a
real POST endpoint at `/api/suggest-priority`.

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
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `no-match`, `toast`
- `smart-toggle` — sparkle button next to the priority dropdown that
  enables/disables AI priority suggestions
- `suggest-bar` — appears below the new-task form when a suggestion is
  pending or available
- `suggest-loading` — visible while `/api/suggest-priority` is in flight
- `suggest-pill` — clickable pill that applies the suggested priority to
  the dropdown when clicked
- `suggest-priority` — span inside the pill containing
  `high` / `normal` / `low`
- `suggest-meta` — small text under/beside the pill describing what
  matched (e.g. "matched: urgent, fix") or "applied: high" after a click

## AI priority API

`POST /api/suggest-priority` with a JSON body of `{ "text": "..." }`
returns `{ "priority": "high"|"normal"|"low", "confidence": 0..1,
"matched": ["urgent", "fix", ...] }`.

Keyword tiers live in `server.js`:

- HIGH: urgent, asap, today, now, fix, bug, broken, prod, production,
  deadline, blocker, critical
- LOW:  later, maybe, someday, fyi, research, explore, consider,
  eventually, wishlist, nice-to-have

A high-tier match always wins over a low-tier match in the same input.
Default with no matches is `normal`. The endpoint adds a ~220 ms
artificial delay so the loading state is observable.
