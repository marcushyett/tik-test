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
start: python3 -m http.server 4173

(The line above tells tik-test to start the static server before running.
No auth required — the app is a single static page served locally.)

## Selectors
Prefer `data-testid` attributes:
- `new-task-input`, `new-task-priority`, `new-task-due-date`, `add-task`
- `filters` container, buttons inside match `[data-filter="all"]`, `[data-filter="active"]`, `[data-filter="done"]`, `[data-filter="high"]`, `[data-filter="today"]`
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`, `due-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `toast`

The login gate accepts any email + the password `hunter2`.

(No hand-written test plan — tik-test should generate one each run from the
focus above plus the PR diff. That's the realistic path: a maintainer
describes what changed and what's risky; the agent figures out how to
exercise it.)
