# Full setup guide — tokens, secrets, and where they go

End-to-end walkthrough: every token you need to create, where to create it,
and where to paste it. Pick the path that matches what you want.

## Decision tree

| You want to… | Read |
|---|---|
| Run tik-test on PRs against any web app you deploy publicly | **Path A** |
| Run tik-test against a Vercel-protected preview/production deployment | **Path A** + **Path B** |
| Deploy the reviewer web app (the swipeable feed) for your team | **Path C** |
| Have tik-test self-review changes to the reviewer web app itself | **Path C** + **Path D** |

For the simplest "I want video reviews on my PRs": just **Path A**. Everything else is additive.

---

## Path A — minimum to run the GitHub Action

You need **one secret**, optionally two more for narration + protected previews.

### A1. `CLAUDE_CODE_OAUTH_TOKEN` (required)

This is what bills the agent's compute against your Claude Code subscription
instead of a separate API key — that's the whole economic model of tik-test.

1. On your local machine:
   ```sh
   claude setup-token
   ```
2. Follow the browser flow. Copy the token (starts with `sk-ant-oat...`).
3. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**
   - **Name**: `CLAUDE_CODE_OAUTH_TOKEN`
   - **Value**: the token from step 2

### A2. `OPENAI_API_KEY` (optional — enables TTS narration)

Without this, videos are silent on Linux runners. macOS uses the system
`say` voice as a fallback locally, but CI runs on Ubuntu.

1. Get a key from <https://platform.openai.com/api-keys>. Any tier works;
   tik-test uses `gpt-4o-mini-tts` which is cheap (cents per video).
2. Same path: **Settings → Secrets and variables → Actions → New repository secret**
   - **Name**: `OPENAI_API_KEY`
   - **Value**: `sk-proj-...`

### A3. Workflow file

Drop this at `.github/workflows/tik-test.yml` in the repo you want reviewed:

```yaml
name: tik-test review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: write
  pull-requests: write
  id-token: write
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: marcushyett/tik-test@v1
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Add a `tiktest.md` (or `claude.md`) at your repo root with at least:
```markdown
## URL
https://your-deployment.example.com
```

Open a PR → tik-test posts a video comment within ~5 minutes.

---

## Path B — Vercel-protected previews/production

Add this **on top of Path A** if your deployment requires Vercel auth to
view (default for Pro/Team plan previews).

### B1. `VERCEL_AUTOMATION_BYPASS_SECRET`

1. Open your project in Vercel: **Project Settings → Deployment Protection → Protection Bypass for Automation**
2. If empty, click **Add Secret** to generate one. Copy it.
3. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**
   - **Name**: `VERCEL_AUTOMATION_BYPASS_SECRET`
   - **Value**: paste

### B2. Wire it into the workflow

Add the input:
```yaml
      - uses: marcushyett/tik-test@v1
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

The action passes the secret as both an `x-vercel-protection-bypass` header
and a query param so it works on every Vercel protection mode.

---

## Path C — deploy the reviewer web app

This is the swipeable feed at `web/`. Skip if you only want video comments
on PRs and don't need the dashboard.

### C1. GitHub OAuth App (for users to log in)

A GitHub **OAuth App** — not a PAT, not a GitHub App.

1. <https://github.com/settings/applications/new>
2. Fill in:
   - **Application name**: `tik-test reviewer` (free-text)
   - **Homepage URL**: `https://<your-deployment>.vercel.app` (your real prod URL)
   - **Authorization callback URL**: `https://<your-deployment>.vercel.app/api/auth/callback/github` (this exact path)
3. Click **Register application**.
4. On the next page, click **Generate a new client secret**. Copy immediately — only shown once.
5. Copy the **Client ID** too.

### C2. `AUTH_SECRET`

```sh
openssl rand -base64 32
```
Copy the output.

### C3. Add three vars to Vercel

In Vercel: **Project Settings → Environment Variables**, add to **Production**
(and **Preview** if you want preview deployments to log in too):

| Name | Value | Sensitive? |
|---|---|---|
| `GITHUB_CLIENT_ID` | from C1 step 5 | no |
| `GITHUB_CLIENT_SECRET` | from C1 step 4 | yes |
| `AUTH_SECRET` | from C2 | yes |

Optional: `NEXTAUTH_URL=https://your-custom-domain.com` — only needed if
you've attached a custom domain (Vercel auto-detects `*.vercel.app` URLs).

### C4. Deploy

```sh
cd web
vercel link             # connect to your Vercel project
vercel deploy --prod
```

Visit the URL → "Sign in with GitHub" should work end-to-end.

---

## Path D — wire the webapp self-review CI

Optional, only if you want the `tik-test-webapp.yml` workflow to log in to
the deployed reviewer for self-tests. Needs the Path C deployment in place
first.

### D1. Fine-grained PAT (the bypass token)

A **fine-grained Personal Access Token**, NOT a classic PAT. Tightly scoped
so even a leak only allows reading public PR data on one repo.

1. <https://github.com/settings/personal-access-tokens/new>
2. Fill in:
   - **Token name**: `tik-test-bypass`
   - **Expiration**: 90 days (rotate quarterly)
   - **Resource owner**: your account (or org if the repo is in an org)
   - **Repository access**: **Only select repositories** → pick the **one** repo under test
   - **Repository permissions** (READ-ONLY for all three; leave the rest as *No access*):
     - **Contents**: Read-only
     - **Metadata**: Read-only (auto-selected)
     - **Pull requests**: Read-only
3. **Generate token**. Copy immediately — starts with `github_pat_...`.

### D2. HMAC secret for signing bypass URLs

```sh
openssl rand -hex 32
```
Copy. **You'll paste this same value in two places** (Vercel + GitHub Actions).

### D3. Add four vars to Vercel (Production only — never Preview)

In Vercel **Project Settings → Environment Variables**:

| Name | Value | Sensitive? |
|---|---|---|
| `TIKTEST_BYPASS_SECRET` | from D2 | yes |
| `TIKTEST_BYPASS_GH_TOKEN` | the `github_pat_...` from D1 | yes |
| `TIKTEST_BYPASS_GH_LOGIN` | your GitHub username | no |
| `TIKTEST_BYPASS_DISABLED` | omit (or `0`) | no — kill switch; set to `1` to disable instantly without a redeploy |

Optional: `TIKTEST_BYPASS_MAX_SKEW_S` (defaults to 60s, clamped to 5–300).

Redeploy.

### D4. Add one secret to GitHub Actions

Same value as D2 — must match exactly:

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**
- **Name**: `TIKTEST_BYPASS_SECRET`
- **Value**: from D2

### D5. Sanity check

```sh
node web/scripts/sign-bypass-url.mjs \
  --base https://<your-deployment>.vercel.app \
  --redirect /
```
Open the printed URL within 60s. Logged in → bypass works. 404 → one of
the four Vercel env vars from D3 is missing in Production.

---

## Master checklist (everything, in one place)

| Token / secret | Where to get it | Where to put it | Required? |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` | GH repo Actions secret | **yes** for any workflow |
| `OPENAI_API_KEY` | platform.openai.com | GH repo Actions secret | optional (TTS) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel → Deployment Protection | GH repo Actions secret | only if Vercel-protected |
| `GITHUB_CLIENT_ID` | New OAuth App on GitHub | Vercel env (Prod + Preview) | only for Path C |
| `GITHUB_CLIENT_SECRET` | Same OAuth App, "Generate secret" | Vercel env (Prod + Preview) | only for Path C |
| `AUTH_SECRET` | `openssl rand -base64 32` | Vercel env (Prod + Preview) | only for Path C |
| `TIKTEST_BYPASS_SECRET` | `openssl rand -hex 32` | **Both** Vercel env (Prod) **and** GH repo Actions secret (same value) | only for Path D |
| `TIKTEST_BYPASS_GH_TOKEN` | New fine-grained PAT, single repo, read-only | Vercel env (Prod only) | only for Path D |
| `TIKTEST_BYPASS_GH_LOGIN` | your GitHub username | Vercel env (Prod only) | only for Path D |

## Maintenance

- **Rotate `TIKTEST_BYPASS_GH_TOKEN`** every 90 days (PAT expiry).
- **Rotate `TIKTEST_BYPASS_SECRET` and `AUTH_SECRET`** if you suspect either
  was logged or echoed anywhere. Rotating `AUTH_SECRET` invalidates all
  live user sessions.
- **Kill switch**: if anything's misbehaving, set `TIKTEST_BYPASS_DISABLED=1`
  on Vercel — takes effect within seconds, no redeploy.
- **Audit log**: every bypass attempt logs a one-line `[tiktest-bypass]`
  record to Vercel runtime logs. Searchable in the Logs UI; pipe to a
  Drain if you want alerting.

## See also

- `web/README.md` — web-app-specific Setup section (subset of Paths C + D)
- `web/src/lib/bypass.ts` — full threat model + defence layers for the
  test-mode bypass
- `SECURITY.md` — vulnerability disclosure
