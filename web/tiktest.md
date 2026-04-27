# tik-test reviewer (web)

The tik-test **reviewer** is a TikTok-style PR feed for AI-generated review
videos. Sign in with GitHub, pick a repo, swipe through every open PR with
a tik-test video attached, tap a verdict pill, and post a real GitHub
review on your behalf. No database; the GitHub access token lives in a
session cookie and nowhere else.

This is a different app from the bundled Taskpad demo at
`examples/todo-app/` — the Taskpad has its own `tiktest.md` next to its
`index.html` and is exercised by the sister workflow
`.github/workflows/tik-test-taskpad.yml`.

## Login

In CI, the agent enters the app via a signed test-bypass URL minted by
`web/scripts/sign-bypass-url.mjs`. The URL hits `/api/test-bootstrap`,
which mints a 30-min session backed by a fine-grained PAT. The full
defence model is documented at the top of `web/src/lib/bypass.ts`.

The bypass URL is passed as `preview-url` to the action — by the time the
agent navigates, the session cookie is set and the app treats them as
the bypass user. **No additional sign-in step is needed in any goal.**

For local manual review, sign in normally with GitHub OAuth.

## Target URL

**Per-PR Vercel preview only.** tik-test is a pre-production tool — it
never targets the production deployment. The workflow at
`.github/workflows/tik-test-webapp.yml` listens for Vercel's
`deployment_status` event and signs the bypass URL against whichever
preview host Vercel just deployed for this PR (e.g.
`tik-test-review-git-<branch>.vercel.app`). All `TIKTEST_BYPASS_*` env
vars on Vercel live in the **Preview** environment only, so the bypass
route returns 404 on Production by design.

For manual dispatch (`workflow_dispatch`), pass the `preview_url` input
explicitly — there's no event payload to read it from.

## Local dev

The reviewer is a Next.js app, not a static site. Run it with:

start: cd web && npm install --silent && npm run dev -- -p 4173

The `start:` directive only matters for local dev — in CI the workflow
signs the bypass URL against the per-PR preview deployment, so no local
server is spun up.

## Selectors

Prefer `data-testid` attributes where available; fall back to visible
text or stable lucide icon labels.

### Landing page (signed-out)
- "Sign in with GitHub" button — primary CTA. Bypass-route entries skip
  this entirely; agents driven from CI never see this page.

### Repo picker (signed-in, "/")
- Search input — placeholder "Search repos…"
- Each repo row links to `/r/<owner>/<repo>`

### PR feed (`/r/<owner>/<repo>`)
- `data-testid` attributes are sparse on this surface; rely on visible
  text, lucide icons (Bot, Check, X, MinusCircle), and ARIA labels.
- Top counter: "PR N of M" + "X/Y green · Z oops"
- Video player with TikTok-style controls (play/pause/skip, persistent
  mute + prev/next-PR buttons in the corner). Controls auto-hide 2.5s
  after the last pointer activity while playing.
- "AI checks" drawer — pass/fail/skipped count badges + per-row glyphs
  (outline lucide icons in the tone colour).
- DecisionForm: Approve / Request Changes / Comment buttons + tone pills
  (LGTM, Ship it, Question, Nit, Blocker, …) + free-text textarea +
  "Post review" button.
- Mobile drawer (PR title pill at the bottom) expands to show metadata,
  AI checks, and the decision form.

## Agent capabilities & guardrails

- The bypass session is **READ-ONLY**. `submitReview` checks
  `session.bypass === true` and refuses, returning
  `"Reviews can't be posted from a test-bypass session."` That refusal is
  itself a useful test surface — clicking "Post review" under bypass
  should always show that error string.
- All other read-only flows (browse repo list, navigate PR feed, scrub
  video timeline, expand mobile drawer, switch PRs) work normally.
- The bypass session expires 30 min after issuance; if a run lasts that
  long the session callback drops `accessToken` and every subsequent
  read-action returns "Not signed in". Plan accordingly — keep goals
  tight.

## API surface for inspection

The agent can use `browser_network_requests` to verify that:
- `/api/auth/session` returns a session with `bypass: true` and the
  expected `login`.
- `/api/test-bootstrap?ts=...&sig=...` (the entry URL) responds with a
  302 redirect.
- Server actions (`submitReviewAction`) return a structured error when
  invoked under bypass.
