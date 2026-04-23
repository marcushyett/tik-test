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
cp .env.example .env.local     # fill in the three values below
npm install
npm run dev
```

**You need a GitHub OAuth app.** Register at <https://github.com/settings/applications/new>:

- **Homepage URL** — your deployment URL (e.g. `https://tik-test-review.vercel.app`).
- **Authorization callback URL** — `https://tik-test-review.vercel.app/api/auth/callback/github`.
- Copy the Client ID + Client Secret into `.env.local` (or Vercel env vars).

**Auth secret:** `openssl rand -base64 32` → `AUTH_SECRET` env var.

## Deploy to Vercel

```sh
cd web
vercel link --yes --scope yolodex --project tik-test-review
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
