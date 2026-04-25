# Taskpad

A tiny single-file todo app, used as the bundled tik-test demo. It's also a
worked example of what a real consumer repo needs to wire tik-test into its
PR review flow.

You can drop this folder into its own repository and everything below will
still work — `claude.md` is the only tik-test-specific file.

## Run locally

```sh
python3 -m http.server 4173 --directory .
# open http://localhost:4173
```

That's the whole app — `index.html` is self-contained.

## How tik-test reviews PRs to this app

`claude.md` (already in this folder) tells tik-test:

- Where the app lives (`http://localhost:4173`)
- What recently changed (the `## Focus` section — narrators open the video with this)
- Which selectors to prefer (`## Selectors`)
- An exhaustive `## Test Plan` JSON — every flow tik-test should exercise

When tik-test runs on a PR, it reads `claude.md`, generates a plan based on
the diff + focus, drives Playwright through it, and posts a 9:16 video back
to the PR with a formal review (`request-changes-on-fail` by default).

## Wire it into GitHub Actions

Add this workflow to `.github/workflows/tik-test.yml` in your repo — that's
the entire setup:

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
  contents: read
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
| `CLAUDE_CODE_OAUTH_TOKEN` | Generated locally with `claude setup-token`. Uses your Claude Max subscription — no per-request billing. |

Optional:

| Secret | When |
|---|---|
| `OPENAI_API_KEY` | Voice-over narration. Without it, the video is silent on Linux runners. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Only if your preview URL has Vercel Deployment Protection enabled. |
| `ANTHROPIC_API_KEY` | Pay-per-use alternative to `CLAUDE_CODE_OAUTH_TOKEN`. |

That's it. Open a PR; tik-test posts a video and a formal review.

## Editing the test plan

`claude.md` has a `## Test Plan` JSON block. Each step is one of:
`navigate`, `click`, `fill`, `press`, `hover`, `wait`,
`assert-visible`, `assert-text`, `screenshot`, or `script`.

You can also delete the `## Test Plan` block entirely — Claude will generate
one from the `## Focus` section + the PR diff. The hand-written plan above
exists so the demo is deterministic across runs.

## License

Same as the parent project (MIT).
