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

## Testing this app with tik-test

The agent reads [`tiktest.md`](./tiktest.md) before each PR review. That's
all of the tik-test config; everything in there is natural language that
Claude parses at runtime.

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
