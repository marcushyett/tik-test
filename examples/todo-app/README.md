# Taskpad

A tiny single-file todo app, used as the bundled tik-test demo. It's also a
worked example of what a real consumer repo needs to wire tik-test into its
PR review flow. You can drop this folder into its own repository and
everything below will still work.

## Run locally

```sh
python3 -m http.server 4173 --directory .
# open http://localhost:4173
```

`index.html` is self-contained; no build step.

## TikTest

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

### URL

http://localhost:4173

### Setup

start: python3 -m http.server 4173

The `start:` prefix tells tik-test to run this command in the background
before the test phase. No auth required; the app is a single static page.

### Login

The login gate accepts any email plus the password `hunter2`.

### Selectors

Prefer `data-testid` attributes:

- `new-task-input`, `new-task-priority`, `add-task`
- `search-row`, `search-input`, `clear-search`
- `filters` container, buttons match `[data-filter="all"]`, `[data-filter="active"]`, `[data-filter="done"]`, `[data-filter="high"]`
- `sort-select` (option values: `newest`, `oldest`, `priority`, `alpha`)
- `tasks` (ul), `task-<id>`, `toggle-<id>`, `del-<id>`
- `stats`, `counter`, `clear-done`, `empty`, `no-match`, `toast`

## Wire it into GitHub Actions

Add this workflow to `.github/workflows/tik-test.yml`:

```yaml
name: tik-test review
on:
  pull_request:
  deployment_status:                    # if you have Vercel / Netlify previews
  workflow_dispatch:
    inputs:
      pr_number:
        description: PR number to review
        required: true

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  review:
    if: |
      github.event_name == 'workflow_dispatch' ||
      github.event_name == 'pull_request' ||
      (github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success')
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: marcushyett/tik-test@v1
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          openai-api-key:          ${{ secrets.OPENAI_API_KEY }}            # optional
          pr-number:               ${{ github.event.inputs.pr_number }}
```

### Secrets

Add **one** required secret (Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Generated locally with `claude setup-token`. Uses your Claude Max subscription, no per-request billing. |

Optional:

| Secret | When |
|---|---|
| `OPENAI_API_KEY` | Voice-over narration. Without it, the video is silent on Linux runners. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Only if your preview URL has Vercel Deployment Protection enabled. |
| `ANTHROPIC_API_KEY` | Pay-per-use alternative to `CLAUDE_CODE_OAUTH_TOKEN`. |

That's it. Open a PR; tik-test posts a video and a formal review.

## License

Same as the parent project (MIT).
