# tik-test review — the web app

TikTok-style review feed for any repo's open PRs that have tik-test videos. Sign in with GitHub, pick a repo, swipe through the videos, drop pill-reactions + free-text, hit **Approve** or **Request changes** — the app posts a real GitHub PR review on your behalf.

**No database.** GitHub is the backend. The access token lives in a JWT session cookie; the only state outside GitHub is "which video index am I on" (in-memory React state).

## Shape

```
/                       → sign in, then repo picker
/r/:owner/:repo         → the feed for that repo
/api/auth/*             → Auth.js v5 routes
```

## Convention: how the feed finds videos

tik-test posts a hidden HTML comment inside each PR review comment:

```html
<!-- tik-test-video:v1 {"v":"1","runId":"...","prRef":"owner/repo#42","createdAt":"2026-04-23T...","planName":"Feature review","videoUrl":"https://github.com/.../releases/download/.../highlights.mp4","gifUrl":"https://github.com/.../preview.gif","totalMs":84330,"stats":{"total":24,"passed":22,"failed":1,"skipped":1}} -->
```

The app accepts a comment as a feed entry only if:

1. The `<!-- tik-test-video:vN … -->` marker is present + parseable JSON.
2. `videoUrl` is a `github.com/.../releases/download/…` path (so someone can't inject a link to their own server).
3. (Optional future check) author matches an allow-listed bot or repo member.

That's it — no database keys to leak, no backend signing service to run.

## Components

| File | Role |
|---|---|
| `src/lib/marker.ts` | Parser for the HTML-comment marker + URL allowlist |
| `src/lib/github.ts` | Server actions: list repos, list PRs, parse markers, submit review |
| `src/components/video-feed.tsx` | Keyboard-navigable TikTok-style feed |
| `src/components/pr-header.tsx` | Title + `+/-`, reviews, CI state |
| `src/components/decision-form.tsx` | Approve/Request-changes + pills + free-text |
| `src/components/comment-list.tsx` | Existing reviewer comments |
| `src/components/pr-body-preview.tsx` | Expand PR description |
| `src/components/repo-picker.tsx` | Filterable list of the user's repos |

All UI components are small (<100 LOC), single-purpose, and composed together in the pages.

## Setup

```sh
cd web
cp .env.example .env.local     # fill in the values below
npm install
npm run dev
```

There are two auth flows. **#1 is required** for any deployment; **#2 is optional** and only needed if you want the `tik-test-webapp.yml` self-review workflow to be able to log in to the deployed app.

### 1. Normal GitHub login — REQUIRED

You need a **GitHub OAuth App** (not a personal access token, not a GitHub App).

1. Register at <https://github.com/settings/applications/new>:
   - **Homepage URL**: `https://<your-deployment>.example.com` (your actual prod URL)
   - **Authorization callback URL**: `https://<your-deployment>.example.com/api/auth/callback/github` (this exact path)
2. **Generate a new client secret** on the next page — copy it immediately (only shown once).
3. Generate `AUTH_SECRET`: `openssl rand -base64 32`.
4. Set in Vercel **Project Settings → Environment Variables → Production** (and Preview if needed):
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET` (mark Sensitive)
   - `AUTH_SECRET` (mark Sensitive)
5. `NEXTAUTH_URL` is optional — only set it for custom domains; Vercel auto-detects otherwise.

### 2. Test-mode bypass — OPTIONAL

Lets the `tik-test-webapp.yml` workflow log in via a signed, time-bound URL. See `web/src/lib/bypass.ts` for the full threat model.

1. **Create a fine-grained PAT** at <https://github.com/settings/personal-access-tokens/new>:
   - **Repository access**: *Only select repositories* → pick the ONE repo under test (do not pick "All repositories").
   - **Repository permissions** (READ-ONLY for all): Contents, Metadata, Pull requests.
   - Leave everything else as *No access*.
   - Suggested expiration: 90 days, then rotate.
   - Worst-case blast radius if leaked = read public PR data on that one repo.
2. **Generate a bypass HMAC secret**: `openssl rand -hex 32`.
3. Set in Vercel **Project Settings → Environment Variables → Preview** (NOT Production — tik-test only targets per-PR previews):
   - `TIKTEST_BYPASS_SECRET` (Sensitive — the HMAC secret from step 2)
   - `TIKTEST_BYPASS_GH_TOKEN` (Sensitive — the `github_pat_…` from step 1)
   - `TIKTEST_BYPASS_GH_LOGIN` (your GitHub username — appears in the session)
   - Optional: `TIKTEST_BYPASS_DISABLED=1` (kill switch — set instantly, no redeploy)
   - Optional: `TIKTEST_BYPASS_MAX_SKEW_S` (defaults to 60s, clamped to 5–300)
4. Set in your GitHub repo **Settings → Secrets and variables → Actions**:
   - `TIKTEST_BYPASS_SECRET` (must match the Vercel value exactly)
   - `VERCEL_AUTOMATION_BYPASS_SECRET` — *required* if the deployment has Vercel Deployment Protection on (default for previews on Pro/Team plans). Without it, the CI browser hits Vercel's auth wall before reaching `/api/test-bootstrap`. Grab it from Vercel **Project Settings → Deployment Protection → Protection Bypass for Automation**. Skip if production is public.

#### Sanity check

```sh
node web/scripts/sign-bypass-url.mjs \
  --base https://<your-deployment>.example.com \
  --redirect /
```

Open the printed URL within 60 seconds. If you land logged in, the bypass works. A 404 on a preview URL means one of the four required env vars is missing in Vercel **Preview**. (A 404 on a production URL is by design — the bypass route is disabled there.)

## Deploy to Vercel

```sh
cd web
vercel link
vercel env add GITHUB_CLIENT_ID     # paste values for each env (preview, production)
vercel env add GITHUB_CLIENT_SECRET
vercel env add AUTH_SECRET
vercel deploy --prod
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `↑` / `k` | Previous PR |
| `↓` / `j` | Next PR |
| `Space` | Play / pause |

## Why no backend

A reviewer blasting through 50 videos doesn't want another account or another set of notifications — they already have GitHub. Everything that matters (the PR, the comments, the video URL, the permissions) is already on GitHub. This app is a thin, cache-friendly view layer on top.

## License

MIT — shares the root repo's [LICENSE](../LICENSE).
