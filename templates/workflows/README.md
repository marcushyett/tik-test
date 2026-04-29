# tik-test workflow templates

Three drop-in `.github/workflows/*.yml` files for the most common ways an
app gets exposed to a CI runner. Pick one, copy it into your repo at
`.github/workflows/tik-test.yml`, and adjust the marked sections.

## Which template?

```
What does your app need to do anything useful?
│
├─ "Just `npm run dev` and it works." ────► local-dev.yml
│
├─ "We deploy a per-PR preview to Vercel." ► vercel-preview.yml
│
└─ "It needs a real database / cache /
    queue / external service to boot." ────► staging-with-services.yml
```

If you're unsure: start with **local-dev.yml**. It's the simplest, and the
common pattern for SPAs / static sites / Next.js apps with mocked APIs.
You can always swap to one of the others later.

## File-by-file

### `local-dev.yml`

The dev server boots **inside the GitHub Actions runner** from a single
`start:` command in your `tiktest.md`. tik-test spawns it, waits for the
URL, drives the browser. Zero infrastructure outside of the runner.

Best for: SPAs, static sites, Next.js with mocked APIs, Storybook,
Vite-driven apps.

### `vercel-preview.yml`

The dev server is **a Vercel preview deployment** the platform builds for
every PR. The workflow polls GitHub's Deployments API for the preview
URL, then hands it to tik-test. Includes the Vercel automation bypass
secret so Deployment Protection doesn't slam the door on the agent.

Best for: anything you already deploy to Vercel — Next.js, SvelteKit,
Astro, Remix, plain static sites.

### `staging-with-services.yml`

The dev server boots **inside the runner**, but only after Postgres +
Redis service containers come up, migrations run, and seeds load. The
workflow orchestrates the full boot sequence; tik-test only drives the
browser. Strip / extend the services list to match your stack.

Best for: Rails, Django, Phoenix, Next.js + Prisma + Postgres, anything
where the app crashes without a real DB.

## Setup walkthrough (any template)

1. Copy your chosen template to `.github/workflows/tik-test.yml`.
2. Read the file's header comment — every template lists its required
   `tiktest.md` shape and required secrets.
3. Add the secrets under repo **Settings → Secrets and variables →
   Actions**:
   - `CLAUDE_CODE_OAUTH_TOKEN` — generate locally with `claude
     setup-token`. Required.
   - `OPENAI_API_KEY` — optional, enables TTS voice-over.
   - `VERCEL_AUTOMATION_BYPASS_SECRET` — required only for
     `vercel-preview.yml` if your previews are protected.
4. (Optional, recommended) Set the `TIKTEST_OWNERS` repo variable to a
   JSON array of GitHub usernames who can trigger paid runs. Default
   falls back to the repo owner. Stops drive-by PRs from burning your
   Claude budget.
5. Open a PR. The workflow runs on `pull_request` (initial open) and
   `workflow_dispatch` (manual re-run from the Actions tab).

## Common gotchas

- **`run-on-every-push: false` is the default**, so a `pull_request`
  `synchronize` event (force-push, follow-up commit) is a deliberate
  no-op. Set `run-on-every-push: true` on the action's `with:` block to
  re-review every commit.
- **Fork PRs are blocked** by the `if:` gate, because GitHub doesn't
  share secrets with forks anyway. Maintainers can still trigger via
  `workflow_dispatch`.
- The action installs Node 22, ffmpeg, and Playwright Chromium itself —
  don't add those steps yourself, you'll just slow the run down.
- `tiktest.md` is your contract with tik-test. The templates show the
  minimum shape; full reference is in the root [`README.md`](../../README.md#telling-tik-test-how-to-test-your-app).
- **Pure-docs / config-only / lockfile-only PRs** are detected by the
  plan generator on every run and skipped cleanly with an explanatory
  comment plus a `tik-test` check-run with `conclusion: skipped`. You
  don't need to scope `paths:` defensively to avoid them — but a
  `paths:` filter is still useful to keep workflow runs off PRs that
  obviously can't affect your app.

## Reference: dogfooded versions

The tik-test repo runs two real workflows on its own PRs that you can
read for working examples:

- [`tik-test-taskpad.yml`](../../.github/workflows/tik-test-taskpad.yml)
  — local-dev variant. Reviews the bundled todo demo at
  `examples/todo-app/`.
- [`tik-test-webapp.yml`](../../.github/workflows/tik-test-webapp.yml) —
  vercel-preview variant. Reviews the deployed reviewer web app at
  `web/`.

Both use `uses: ./` (path to local action) instead of
`uses: marcushyett/tik-test@v1` (consumer-facing). Other than that,
they're the same shape as the templates.
