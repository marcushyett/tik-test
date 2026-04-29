
# tiktest

**Automated TikTok-style video review of every PR.**

the more I shipped stuff with claude the more I realised; in the long term the most value I can add as a human is testing - finding the stuff other humans would struggle with...

...but testing is boring. so I tried to make it less boring - or at least take way less of my time.

<p align="center">
  <a href="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.mp4">
    <img src="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.gif" alt="tik-test demo: 9:16 narrated video review of a PR" width="320" />
  </a>
  <br />
  <a href="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.mp4"><strong>Play with sound</strong></a> to hear narration and watch normal speed
</p>

<div align="center">

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

## Get it running in a few mins

Copy one of these prompts into [Claude Code](https://docs.claude.com/en/docs/claude-code/setup). Claude does the wiring.

**Wire it into a GitHub repo** — `cd` into your repo, open Claude Code, paste:

````
Set up tik-test (https://github.com/marcushyett/tik-test — 45s video reviews on every PR) on this repo:
1. Read the project README, especially the "GitHub Action" section and templates/workflows/.
2. Pick the right workflow template (local-dev / vercel-preview / staging-with-services) by inspecting this repo's package.json, framework configs, and deploy setup. Ask me if it's ambiguous.
3. Create .github/workflows/tik-test.yml from that template, adapted for this project (build command, port, etc).
4. Draft a tiktest.md at repo root: short app description, login (ask me for creds), risky surfaces.
5. List the GitHub Secrets I need to add (CLAUDE_CODE_OAUTH_TOKEN required; OPENAI_API_KEY + VERCEL_AUTOMATION_BYPASS_SECRET optional) with one-line instructions on getting each.
6. Open a PR so the workflow self-tests on the change you just made.
````

**Install the Claude Code plugin** — records a walkthrough of whatever you just shipped, locally. Open Claude Code in your project, paste:

````
Install the tik-test Claude Code plugin and set it up for this project:
1. Run /plugin marketplace add marcushyett/tik-test
2. Run /plugin install tiktest@tiktest
3. Run /reload-plugins
4. Verify ffmpeg, playwright chromium, and `npm i -g tik-test` are installed — fix what's missing for my OS.
5. Run /tiktest:setup to scaffold tiktest.md for this repo, asking me for anything you can't infer.
6. Tell me how to invoke /tiktest:run (full video) and /tiktest:quick (checklist only) after I ship a feature.
````

---

## The problem

AI ships **20+ PRs a day** that mostly work. Where it fails is taste: awkward flows, off-brand copy, the counter-intuitive ways real users click. Catching that means dropping what you're doing, opening the PR, exercising it, then switching back. **Twenty context switches a day.**

tik-test puts a **45-60s narrated video** on every PR: happy path, edge cases, bugs called out on camera. You skim 20 in your inbox between meetings and only context-switch into the ones that look off.

> The bottleneck of building products is shifting from writing code to **testing it well**. tik-test is a bet on that.

## Prerequisites

| What | Why |
|---|---|
| **A web app with a public preview URL** | tik-test drives a real browser. Vercel, Netlify, Render, ngrok-tunneled localhost. |
| **A `## TikTest` section in your repo's `README.md`** | tells the agent the URL, login, and what's risky in this PR. See [Telling tik-test how to test your app](#telling-tik-test-how-to-test-your-app) below. |
| **A Claude Code Max subscription** OR **an Anthropic API key** | tik-test invokes `claude` CLI directly so cost comes out of your subscription. OAuth recommended; API key works. |
| **CI permissions** | `contents: write`, `pull-requests: write`, `id-token: write`. |

**Optional:**

- `OPENAI_API_KEY` for voice narration (silent on Linux without it).
- `VERCEL_AUTOMATION_BYPASS_SECRET` for protected previews.
- **Claude Code CLI** (only required if you want to use the [Claude Code plugin](#3-claude-code-plugin)): install from <https://docs.claude.com/en/docs/claude-code/setup>.

---

## Telling tik-test how to test your app

Two pieces of context, in two different places:

**1. Project-level: `tiktest.md` at your repo root.** Stable across PRs. Describes the app and how to sign in. Free-form prose, no schema.

```markdown
# Acme

Acme is a project tracker for engineering teams.

Login: email `review-bot@acme.app`, password `hunter2`
```

**2. PR-level: a "what to test" note in your PR description.** Changes per PR. Tells the agent which surfaces this change touches and what's risky. Skip it and tik-test plans from the diff alone (best-effort).

```markdown
## What to test
- Bulk archive on the tasks list. Select 5+ items, archive, confirm count.
- Empty state when all tasks are archived.
```

### Where the URL comes from

Two ways tik-test learns where to point the browser. Pick whichever fits your setup:

- **Per-PR preview URLs** (Vercel / Netlify / similar). Auto-detected from the `deployment_status` event in CI. Don't put a URL in `tiktest.md`; the action handles it. This is the common case.
- **Stable test-environment URL** (e.g. `dev.acme.app` always points at trunk). Add it to `tiktest.md`: any `https://...` link in the file works.

If both are present the auto-detected preview URL wins.

---

## How it's designed (and what it won't suit)

tik-test was built for **small, focused PRs that touch one user-facing slice at a time**. This is what Alistair Cockburn calls [Elephant Carpaccio](https://alistaircockburn.com/Elephant-Carpaccio): nano-slices that each ship value end-to-end. If you bundle ten features into a 2,000-line PR, **break it up**, or the video will skim two and miss the rest.

### Works well

- **PRs touching one user-facing slice.** Forms, dialogs, lists, navigation, a single end-to-end flow. The agent picks 1-3 goals and probes them deeply.
- **Flows the agent can drive via Playwright MCP.** Clicks, typing, hovers, keyboard shortcuts, dropdowns, file uploads. Slow flows with login spinners are fine; the editor crops idle waits to 0.3s.
- **Multi-page wizards** with seconds of actual interaction. Page transitions aren't the problem; total interaction count is.
- **Public-ish preview URLs.** Vercel-protected works via the bypass secret.
- **Visible failures.** Broken layout, validation that contradicts the input, button that doesn't fire, badge with the wrong colour.

### Won't suit

- **Giant PRs adding 10+ features at once.** The plan picks 1-3 goals; the rest go uncovered.
- **Design studios, canvas tools, drag-precise interactions.** Figma-style apps, video editors. Playwright can drive a `<canvas>` but the agent can't tell whether it dragged the handle to the right spot.
- **Apps gated behind SAML, SSO, MFA, or per-tenant subdomains** with no automation bypass.
- **Subtle regressions with no visible surface.** Wrong analytics event, wrong DB write, p95 perf regression, Safari-14-only CSS bug.

Defaults reflect how I review PRs: small slices, fast feedback, video-first. Run `node dist/cli.js config` to retune.

---

## In the wild

The demo above is the bundled Taskpad app. Agent caught two planted bugs (case-sensitive search, priority-sort reversed) and posted a request-changes review.

Self-test: every PR to this repo gets reviewed by tik-test against the bundled [Taskpad demo](examples/todo-app/) — see the most recent PR for an example video.

## Watch in a feed

[**tiktest.dev**](https://tiktest.dev) is a TikTok-style web viewer for your tik-test videos. Pure pass-through: GitHub is the backend, we store nothing, no auth required beyond your existing GitHub login. Self-host instead with `node dist/cli.js view` against your local runs directory.

---

## How it works

```
                    ┌──────────────┐
                    │  tiktest.md  │◄── PR body, config, optional inline goal list
                    └──────┬───────┘
                           ▼
     ┌─────────────────────────────────────────────┐
     │ 1. Plan           1-3 high-level goals      │  ← Claude generates
     │ 2. Drive          Agent runs Playwright MCP │  ← records raw.webm + tool log
     │ 3. Narrate        Claude writes the script  │  ← intro + beats + outro, one call
     │ 4. Voice          OpenAI TTS (voice: ash)   │  ← one WAV per beat
     │ 5. Trim           FFmpeg crops idle waits   │  ← login spinners → 0.3s
     │ 6. Compose        Remotion overlays         │  ← pan/zoom, captions, clicks, audio
     │ 7. Checklist      Claude summarises 6-10    │  ← AI-checks list shown on outro
     │ 8. Publish        GitHub release + comment  │  ← + formal PR review (approve/reject)
     └─────────────────────────────────────────────┘
                           ▼
                  `highlights.mp4` + `preview.gif`
```

**Design notes:**

- **One continuous master video**, not per-step clips. Every overlay references the same timeline so desync is structurally impossible.
- **Voice paces the video.** Each beat sized to its narration; playbackRate clamped 1.0–1.6x.
- **Remotion is compositor-only.** CSS transforms over the pre-trimmed master; ~20 fps render on Apple Silicon in `--quick` mode.
- **`claude` CLI invoked directly** (not the SDK), so compute bills against your Claude Code Max subscription.

---

## Install

```sh
# macOS
brew install ffmpeg node
gh auth login
git clone https://github.com/marcushyett/tik-test
cd tik-test
npm install
npx playwright install chromium
npm run build
```

```sh
# Ubuntu / GitHub Action runner
sudo apt-get install -y ffmpeg fonts-dejavu
npm install
npx playwright install chromium --with-deps
npm run build
```

---

## Quickstart

### 1. Local app

```sh
python3 -m http.server 4173 --directory examples/todo-app &
node dist/cli.js run --config examples/todo-app/tiktest.md --quick
```

### 2. GitHub PR

```sh
export OPENAI_API_KEY=...                            # voice (optional)
export VERCEL_AUTOMATION_BYPASS_SECRET=...           # protected previews (optional)

node dist/cli.js pr https://github.com/owner/repo/pull/42
```

Useful flags:

| Flag | What |
|---|---|
| `--quick` | 540×960 draft render, ~2 min |
| `--skip-clone` | Run against current working directory |
| `--skip-comment` | Render but don't post |
| `--require-pass` | Exit non-zero if any goal failed |
| `--review <mode>` | `none` · `approve-on-pass` · `request-changes-on-fail` (default) · `always` |
| `--vercel-bypass <secret>` | Bypass header + cookie |
| `--no-voice` | Silent video |

### 3. Claude Code plugin

Already inside a Claude Code session? Four-step setup, two of which are one-time-per-machine.

**Step 1 — install runtime prereqs (one-time per machine):**

```sh
npm install -g tik-test                          # CLI binary the plugin shells out to
npx playwright install chromium                  # browser the agent drives
```

You also need `ffmpeg` on PATH (`brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Linux) and a `claude` CLI signed in (`claude setup-token`).

**Step 2 — add the marketplace and install the plugin (one-time per machine):**

In your Claude Code prompt:

```
/plugin marketplace add marcushyett/tik-test
/plugin install tiktest@tiktest
```

The slash commands are now available across all your future Claude Code sessions.

**Step 3 — scaffold a `tiktest.md` for your project (one-time per project):**

`cd` into your project, then:

```
/tiktest:setup
```

This inspects your `package.json` / `README.md` / framework configs to draft a `tiktest.md`, then asks you for anything it can't infer (login credentials, special URLs, areas to focus on).

**Step 4 — record or test (whenever you ship a feature):**

```
/tiktest:run                          # agent test pass + MP4 walkthrough on Desktop + pass/fail checklist
/tiktest:run http://localhost:5173    # explicit URL (skip the dev-server probe)
/tiktest:quick                        # no video — faster, prints checklist in chat
```

Or invoke the bundled sub-agent from any session: *"Use the tiktest-runner agent to record a walkthrough of the feature I just shipped."*

The agent reads `git diff origin/main..HEAD`, summarises what you changed, lists the things it'll exercise, then runs. Soft confirmation — interrupt with words if you want a different focus.

**Updating the plugin** later: `/plugin marketplace update tiktest`.

**Hacking on the plugin itself?** Clone the repo and use `claude --plugin-dir ./plugin` — see [docs/PLUGIN.md](docs/PLUGIN.md) for the development install + troubleshooting guide.

---

## Inline test plan (optional)

By default the agent generates a plan from the PR diff plus your `## TikTest` section. For deterministic coverage, add a `### Test Plan` sub-section with a JSON goals list:

```json
{
  "name": "Theater mode",
  "summary": "Verify the new full-screen viewer keeps keyboard shortcuts working.",
  "startUrl": "https://acme-pr-42.vercel.app",
  "goals": [
    { "id": "open-theater", "intent": "Open the Inspiration grid and click Theater on any card.", "shortLabel": "Open Theater" },
    { "id": "kbd-shortcuts", "intent": "While in Theater mode, press Down, S, then Esc, verifying each works.", "shortLabel": "Keyboard nav", "importance": "high" }
  ]
}
```

**Goal fields:** `intent` (required) · `shortLabel` (3-5 word checklist headline) · `success` (observable success condition) · `importance` (`low` · `normal` · `high` · `critical`).

**Discovery order** when running `tik-test pr`: `tiktest.md` (preferred), then `README.md` with a `## TikTest` heading, then legacy fallbacks (`claude.md` → `CLAUDE.md` → `.claude/claude.md` → bare `README.md`).

---

## GitHub Action

> **Quick start:** copy one of the drop-in templates from
> [`templates/workflows/`](./templates/workflows/) into your repo at
> `.github/workflows/tik-test.yml`. There are three, picked by what your
> app needs to boot:
>
> - [`local-dev.yml`](./templates/workflows/local-dev.yml) — `npm run dev`
>   inside the runner. Best for SPAs, static sites, Next.js with mocked
>   APIs.
> - [`vercel-preview.yml`](./templates/workflows/vercel-preview.yml) —
>   drive your per-PR Vercel preview deployment. Includes the
>   automation-bypass plumbing.
> - [`staging-with-services.yml`](./templates/workflows/staging-with-services.yml)
>   — boots Postgres + Redis service containers, runs migrations + seeds,
>   then starts the app. Best for Rails / Django / Next.js + Prisma.
>
> See [`templates/workflows/README.md`](./templates/workflows/README.md)
> for the chooser tree and the per-template `tiktest.md` shape they expect.
>
> The minimal hand-written form below is kept as a reference if you want
> to wire it up yourself.

```yaml
# .github/workflows/tik-test.yml (rename to whatever you want — pick a path
# that matches your repo layout)
name: tik-test review
on:
  deployment_status:                    # after Vercel/Netlify preview is Ready
  pull_request:                         # or run directly on PRs
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
          vercel-bypass-secret:    ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}  # optional
          pr-number:               ${{ github.event.inputs.pr_number }}     # workflow_dispatch only
```

The action installs Node + ffmpeg + Playwright, builds tik-test, auto-detects the PR number and preview URL, runs the review, posts back.

### Inputs

| Input | Required | Default | What |
|---|---|---|---|
| `claude-code-oauth-token` | Yes¹ | n/a | From `claude setup-token`. Bills your Claude Code Max subscription. |
| `anthropic-api-key` | Yes¹ | n/a | Pay-per-use alternative. |
| `openai-api-key` | No | n/a | Enables OpenAI TTS. Silent on Linux without it. |
| `vercel-bypass-secret` | No | n/a | Vercel automation bypass. |
| `pr-number` | No | auto | From `pull_request` / `deployment_status` / `workflow_dispatch`. |
| `preview-url` | No | auto | From `deployment_status.target_url` or `tiktest.md`. |
| `review-mode` | No | `request-changes-on-fail` | `none` · `approve-on-pass` · `request-changes-on-fail` · `always` |
| `require-pass` | No | `true` | Non-zero exit on any failed goal. |
| `quick` | No | `true` | Draft 540×960 render. |
| `quick-and-dirty` | No | `false` | Drops to 0.5× render (540×960) **and** caps body scenes at 6. Faster, lower-quality output — use when speed beats fidelity. |
| `no-video` | No | `false` | Skip render + upload entirely. Same plan + agent + checklist; posts a text-only checks-only PR comment instead of an MP4. **~5× faster** — pairs well with `run-on-every-push: true`. The checks-only comment deliberately omits the `tik-test-video:v1` marker so the reviewer web app does not pick it up as a feed entry. |
| `run-on-every-push` | No | `false` | Re-review on every commit pushed to a PR (the `synchronize` event). Off by default to keep Claude usage under control. |
| `working-directory` | No | repo root | Subdirectory containing `tiktest.md`. Useful for monorepos. |
| `plan-timeout` | No | `240` (s) | Plan-generation Claude call. Bump for huge diffs. |
| `agent-timeout` | No | `600` (s) | Per-goal agent. Bump for slow page loads. |
| `narration-timeout` | No | `540` (s) | Narration Claude call. Bump for 12+ tool moments. |

> Plus more typed inputs for fine-tuning (`feature-finder-timeout`, `max-goals`, `min-chunk-seconds`, `max-body-scenes`, `checklist-min-items`, `checklist-max-items`, `intro-seconds`, `outro-seconds`, `outro-hold-seconds`). See [Advanced](#advanced) or `node dist/cli.js config`.

¹ One of the two. OAuth recommended.

### Secrets

| Secret | Required? | Use |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | `claude setup-token` locally, paste into Settings → Secrets |
| `OPENAI_API_KEY` | optional | voice-over narration |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | optional | Vercel Deployment Protection |
| `ANTHROPIC_API_KEY` | optional | pay-per-use alternative to OAuth |

For the full end-to-end walkthrough — every token, where to create it, and where to paste it (including the optional reviewer web app + self-review CI) — see [`docs/SETUP.md`](./docs/SETUP.md).

### Gating

- `review-mode: request-changes-on-fail` (default) blocks merge on repos requiring approval.
- `require-pass: true` (default) turns the check red on failure.
- Set `require-pass: false` to keep the check green and rely only on the formal review.

### Self-hosted reference

This repo dogfoods the action with two path-scoped workflows: [`tik-test-taskpad.yml`](.github/workflows/tik-test-taskpad.yml) (runs on PRs touching `examples/todo-app/**`) and [`tik-test-webapp.yml`](.github/workflows/tik-test-webapp.yml) (runs on PRs touching `web/**`). Both use `uses: ./` instead of `marcushyett/tik-test@v1`.

---

## Troubleshooting

**"Plan generation timed out after 240000ms"**
PR diff is huge or `tiktest.md` is missing. Bump `plan-timeout: 480` or trim the diff.

**"Per-goal agent timed out after 600000ms"**
Agent stuck. Page didn't load, login is broken, or the goal is too vague. Check the last `mcp__playwright_*` tool call. If your app is just slow, bump `agent-timeout: 1200`.

**"Narration generation timed out after 540000ms"**
Recording too long (15+ tool calls). Trim goals, bump `narration-timeout: 900`, or set `TIK_MAX_BODY_SCENES=8`.

**Silent video on the GitHub runner**
Set `OPENAI_API_KEY`. Without it, Linux runners ship silent.

**Agent clicks the wrong button**
Add a `## Hints` section to `claude.md` describing the surface, or add `data-testid` attributes. The plan generator sees the diff but not the rendered DOM.

**`claude: command not found` in CI**
Use the GitHub Action; it bundles the install. Outside CI, run `npm i -g @anthropic-ai/claude-code`.

**PR comment shows the marker but the video is broken**
Expected fallback: if any post-process step crashes, tik-test still uploads the raw recording. Check run artifacts.

---

## Advanced

> Run `node dist/cli.js config` to print every knob with its current value, default, override hint, and risks. Same data as below, scoped to your environment.

<details>
<summary><strong>Every env-var knob: defaults, rationale, and risks of changing them</strong></summary>

Defaults are tuned for a typical PR (1-3 goals, 30-60s recording, 8-12 narration scenes, 6-10 checklist items) on a Claude Max subscription. Bump only after you've seen the corresponding default fail in your run.

Every knob has a matching typed input on the GitHub Action (kebab-case version of the env-var, dropping the `TIK_` prefix and `_MS` suffix). Prefer the typed input in YAML.

### Voice / TTS

| Var | Default | Rationale | Risk if changed |
|---|---|---|---|
| `OPENAI_API_KEY` | _(unset)_ | OpenAI TTS produces a natural voice on Linux runners (where `say` doesn't exist). | Silent video in CI without it. |
| `TIK_TTS_VOICE` | `ash` | Reads technical content clearly without sounding robotic. | Other voices may misread code identifiers. |
| `TIK_TTS_MODEL` | `gpt-4o-mini-tts` | Cheap and fast. Higher tier doesn't measurably improve clip quality. | Higher tier = slower + costlier; lower = mispronunciation. |

### Auth

| Var | Default | Rationale | Risk if changed |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | _(unset)_ | Paid fallback when OAuth token isn't present. | Bypasses Claude Code Max; billing shifts to per-token. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | _(unset)_ | Header + cookie so Vercel-protected previews are reachable from CI. | Without it, protected previews 404 the agent. |

### Debugging

| Var | Default | Rationale | Risk if changed |
|---|---|---|---|
| `TIK_KEEP_PUBLIC=1` | _(off)_ | Keeps per-run `public/` directory (master MP4, voice WAVs, raw recordings). | Disk fills if you forget to clean up. |
| `TIK_KEEP_CLONE=1` | _(off)_ | Keeps the temp directory tik-test clones PRs into. | Same disk caveat. |
| `TIK_FFMPEG_DEBUG=1` | _(off)_ | Prints every ffmpeg invocation. | Verbose. |
| `TIK_REMOTION_DEBUG=1` | _(off)_ | Verbose Remotion renderer logs. | Verbose. |

### Claude CLI timeouts (millisecond)

The Action exposes all four as typed seconds inputs (`plan-timeout`, `agent-timeout`, `narration-timeout`, `feature-finder-timeout`). Prefer those in YAML.

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_PLAN_TIMEOUT_MS` | `240000` (4 min) | Plan call digesting PR diff + `tiktest.md`. 4 min handles a 500-line diff. | Small diffs may still take 60s+. Too low and you time out before the plan is drafted. | Wastes CI budget on hung Claude processes. |
| `TIK_AGENT_TIMEOUT_MS` | `600000` (10 min) | EACH per-goal browser-driving call. 10 min covers 12-tool-call goals with slow login. | A real cold start (Vercel preview waking up) can eat 90s alone. | Hung agents drain the 25-min job budget. |
| `TIK_NARRATION_TIMEOUT_MS` | `540000` (9 min) | One narration call covering intro + outro + every scene line. Sonnet handles ~12 scenes in 5-8 min. | Long runs (15+ scenes) regularly hit 6+ min. Too low forces silent fallback. | Trim scenes via `TIK_MAX_BODY_SCENES` instead; raising this doesn't unstick a wedged Claude. |
| `TIK_FEATURE_FINDER_TIMEOUT_MS` | `60000` (1 min) | Fallback when `startUrl` lands on a 404; Claude tries to find a working URL. | Fallback may give up on apps with slow routing. | Almost never doing useful work past 60s. |

### Body-narration density

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_MIN_CHUNK_S` | `3.5` (s) | Shorter consecutive moments coalesce into the previous chunk. 3.5s gives Claude breathing room per scene line. | <2s = many tiny scenes = narration prompt blows up = sonnet timeouts. | >6s = scenes feel sluggish, captions repeat themselves. |
| `TIK_MAX_BODY_SCENES` | `12` | Hard ceiling after coalescing. Above 12 we sample evenly. | <8 misses interesting moments (agent clicks then jump-cut). | >14 risks narration timeout on a 25+ tool run. |

### Outro checklist sizing

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_CHECKLIST_MIN_ITEMS` | `4` | Below 4 the checklist looks scrappy and we treat the LLM call as failed. | <3 = list always looks empty. | >6 = LLM frequently fails on tiny PRs. |
| `TIK_CHECKLIST_MAX_ITEMS` | `10` | Largest count that stays scannable in the 9:16 outro card. Dense layout kicks in past 7. | <6 hides legitimately interesting checks. | >12 overflows the safe band on mobile. |

### Intro / outro durations

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_INTRO_TARGET_S` | `4.5` (s) | Title card window. | <3s = title flashes by; viewers miss PR context. | >6s = boring opening; viewers swipe away. |
| `TIK_OUTRO_TARGET_S` | `4.0` (s) | Outro narration window. | <3s = narrator races. | >5s = drags after action ends. |
| `TIK_OUTRO_HOLD_S` | `3.5` (s) | Extra time after voice ends so the checklist stays readable. | <2s = reviewers can't finish reading. | >5s = video feels long. |

</details>

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
# 1. Change code, 2. rebuild, 3. dogfood:
npm run build
OPENAI_API_KEY=... node dist/cli.js run --config examples/todo-app/tiktest.md --quick
```

## License

MIT. See [LICENSE](LICENSE).
