<div align="center">

# 🎬 tik-test

**A 45-second TikTok-style video review on every PR — so you can review 20 AI-generated PRs in under 15 minutes.**

</div>

<p align="center">
  <a href="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.mp4">
    <img src="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.gif" alt="tik-test demo — 9:16 narrated video review of a PR" width="320" />
  </a>
  <br />
  ▶ <a href="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.mp4"><strong>Play with sound</strong></a> — narrated walkthrough + outro AI-checks list
</p>

<div align="center">

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](package.json)
[![Runs on macOS + Linux](https://img.shields.io/badge/runs_on-macOS%20%7C%20Linux-black)](#install)

</div>

---

## The problem

AI ships **20+ PRs a day** that mostly work. Where it fails is taste — awkward flows, off-brand copy, the counter-intuitive ways real users click. Catching that means spinning up a dev environment for every PR, signing in, finding the change, exercising the edges. **Hours per day.**

tik-test puts a **45-60s narrated video** on every PR — happy path, edge cases, bugs called out on camera. You scan 20 of them in your inbox and only spin up the ones that need a closer look.

> The bottleneck of building products is shifting from writing code to **testing it well**. tik-test is a bet on that.

## Prerequisites

Before you wire tik-test into a repo, make sure you have:

| What | Why |
|---|---|
| **A web app with a public preview URL** | tik-test drives a real browser — Vercel, Netlify, Render, or any deploy with an HTTPS URL works. Localhost via tunnel works too. |
| **A `claude.md` (or `CLAUDE.md`) at the repo root** | tells the agent the URL, viewport, and any login/setup steps. See [Config](#config-claudemd) below. Minimum 5 lines. |
| **A Claude Code Max subscription** OR **an Anthropic API key** | tik-test invokes `claude` CLI directly so cost comes out of your existing subscription. The OAuth-token route is recommended; API-key works as a paid fallback. |
| **GitHub repo permissions** in CI: `contents: write`, `pull-requests: write`, `id-token: write` | for posting the video as a release asset, commenting + reviewing the PR, and Claude OIDC auth respectively. |

**Optional but recommended:**

- `OPENAI_API_KEY` for voice narration (without it the video is silent on Linux runners).
- `VERCEL_AUTOMATION_BYPASS_SECRET` if your Vercel preview is protected.

---

## How it's designed (and what it won't suit)

tik-test was built around a particular way of shipping: **small, focused PRs that touch one user-facing slice at a time** — what Alistair Cockburn calls [Elephant Carpaccio](https://alistaircockburn.com/Elephant-Carpaccio), the practice of slicing work into nano-slices that each ship end-to-end value. If that's how your team works, tik-test fits the gap perfectly. If you ship 2,000-line PRs that bundle ten unrelated features, **you'll need to break them up** — or the video will skim two of the ten and miss the rest.

### Works well

- **PRs that change one user-facing slice** — a form, a dialog, a list, a navigation rework, a single end-to-end flow. The agent picks 1-3 goals and exercises them deeply, including edge cases.
- **Flows the agent can drive via Playwright MCP** — clicks, typing, hovers, keyboard shortcuts, dropdowns, file uploads. Including flows that *take* 10 minutes to run because of slow networks / spinners — the editor crops idle waits down to 0.3s, so the video is still ~60s.
- **Multi-page wizards** that finish in seconds of actual interaction (signup → select plan → confirm). Page transitions aren't the problem; total interaction count is.
- **Apps with a public-ish preview URL** — Vercel, Netlify, Render, ngrok-tunneled localhost. Vercel-protected previews work via the bypass secret.
- **Visible failures** — broken layout, validation error that contradicts the input, button that doesn't fire, badge with the wrong colour or wrong text, a flow that loops or 404s.

### Won't suit

- **Giant PRs that add 10+ features at once.** The plan generator picks 1-3 goals from the diff; the rest go uncovered. tik-test deliberately rewards Carpaccio-style slicing — break it up if you want everything reviewed.
- **Design studios / canvas tools / drag-precise interactions.** Figma-style apps, video editors, anything where pixel-precise drag matters. Playwright can drive a `<canvas>`, but the agent has no idea whether it dragged the handle to the right spot.
- **Apps gated behind SAML / SSO / MFA / per-tenant subdomains** with no automation bypass. tik-test can't get past auth it doesn't have credentials for.
- **Subtle regressions with no visible surface** — wrong analytics event fired, wrong DB write, a perf regression that only shows up at p95, a CSS specificity change that only breaks on Safari 14.
- **Apps that need real seeded data** to demonstrate the feature. If your "list view" is empty until 50 fixtures are loaded, the agent will see an empty list and not much else.
- **Right-to-left languages** — the caption layout assumes LTR. (PRs welcome.)

### A note on this version

The defaults — 1-3 goals per run, ~60s output, 4-min plan budget, 10-min agent budget — were tuned around how I personally review PRs: small slices, fast feedback, video-first. If your team works differently, every knob is configurable (run `node dist/cli.js config`) but you may also be a poor fit for the underlying assumption.

---

## In the wild

The demo above is the bundled Taskpad app — agent caught two deliberately-planted bugs (case-sensitive search, priority-sort reversed) and posted a request-changes review.

A real-world example: [yolodex-ai/personadex#282](https://github.com/yolodex-ai/personadex/pull/282#issuecomment-4301341770) — 19/19 steps green through a Theater-mode flow (magic-link sign-in → Inspiration grid → `▶ Theater` → ↓ → S → Esc).

---

## How it works

```
                    ┌──────────────┐
                    │  claude.md   │◄── PR body, config, optional inline goal list
                    └──────┬───────┘
                           ▼
     ┌─────────────────────────────────────────────┐
     │ 1. Plan           1-3 high-level goals      │  ← Claude generates
     │ 2. Drive          Agent runs Playwright MCP │  ← records raw.webm + tool log
     │ 3. Narrate        Claude writes the script  │  ← intro → beats → outro, one call
     │ 4. Voice          OpenAI TTS (voice: ash)   │  ← one WAV per beat
     │ 5. Trim           FFmpeg crops idle waits   │  ← login spinners → 0.3s
     │ 6. Compose        Remotion overlays         │  ← pan/zoom, captions, clicks, audio
     │ 7. Checklist      Claude summarises 6-10    │  ← AI-checks list shown on outro
     │ 8. Publish        GitHub release + comment  │  ← + formal PR review (approve/reject)
     └─────────────────────────────────────────────┘
                           ▼
                  `highlights.mp4` + `preview.gif`
```

**Key design decisions:**

- **One continuous master video**, not per-step clips. Every overlay (audio, caption, cursor, click flash, pan/zoom) references the same timeline so desync is structurally impossible.
- **Voice is the source of truth for pacing.** Each beat's window is sized to its narration, then the audio's playbackRate is clamped (1.0–1.6x) so a too-long line never bleeds into the next beat.
- **Remotion is compositor-only.** Zoom and pan are simple CSS transforms over the pre-trimmed master — Chrome stays hot, render is ~20 fps on Apple Silicon in `--quick` mode.
- **`claude` CLI directly invoked** (not the SDK) — so compute bills against your existing Claude Code Max subscription, not a separate API key.

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

### 1. Run against a local app

```sh
# Spin up the bundled demo (Taskpad with a deliberate bug)
python3 -m http.server 4173 --directory examples/todo-app &

# Run tik-test
node dist/cli.js run --config examples/todo-app/claude.md --quick
# → ~/Desktop/... (follow the final log line for the exact path)
```

### 2. Run against a GitHub PR

```sh
# Auto-detects Vercel preview URLs in the PR body / comments
export OPENAI_API_KEY=...                            # voice-over (optional)
export VERCEL_AUTOMATION_BYPASS_SECRET=...           # protected previews (optional)

node dist/cli.js pr https://github.com/owner/repo/pull/42
# → clones repo, finds claude.md/README, generates exhaustive plan,
#   runs it, uploads video as GitHub release asset, posts PR comment,
#   posts formal PR review (request-changes if anything failed).
```

Useful flags:

| Flag | What |
|---|---|
| `--quick` | 540×960 draft render, ~2 min |
| `--skip-clone` | Run against current working directory |
| `--skip-comment` | Don't post to the PR (dry-run) |
| `--require-pass` | Exit non-zero if any goal failed (for CI gating) |
| `--review <mode>` | `none` · `approve-on-pass` · `request-changes-on-fail` (default) · `always` |
| `--vercel-bypass <secret>` | Attach the bypass header + cookie on the Playwright context |
| `--no-voice` | Skip the voice-over (silent video) |

---

## Config (`claude.md`)

A minimal config:

```md
---
name: Taskpad
viewport: 900x760
---

## URL
http://localhost:4173

## Focus
Explain the problem this PR solves so the narrator can open the video with it.
Describe what's risky and what to probe hard.

## Setup
start: npm run dev
# `start:` prefix runs this as a background process before tests
```

**Optional inline plan.** Omit this entirely and Claude generates one from the PR diff. Provide it under a `## Test Plan` heading when you want deterministic coverage:

```json
{
  "name": "Theater mode",
  "summary": "Verify the new full-screen viewer keeps keyboard shortcuts working.",
  "startUrl": "http://localhost:4173",
  "goals": [
    { "id": "open-theater", "intent": "Open the Inspiration grid and click ▶ Theater on any card.", "shortLabel": "Open Theater" },
    { "id": "kbd-shortcuts", "intent": "While in Theater mode, press ↓, S, then Esc — verify each works.", "shortLabel": "Keyboard nav", "importance": "high" }
  ]
}
```

**Goal fields:** `intent` (natural-language instruction, required) · `shortLabel` (3-5 word headline for the outro checklist) · `success` (observable success condition) · `importance` (`low` · `normal` · `high` · `critical`).

**Discovery order** when running `tik-test pr`: `claude.md` → `CLAUDE.md` → `.claude/claude.md` → `tik-test.md` → `README.md`.

---

## GitHub Action

tik-test ships as a **composite GitHub Action**. Drop it into your workflow with one `uses:` line:

```yaml
# .github/workflows/tik-test.yml
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
  contents: write                       # for uploading the video as a release asset
  pull-requests: write                  # for comments + review submissions
  id-token: write                       # for Claude Code OIDC auth

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
          pr-number:               ${{ github.event.inputs.pr_number }}     # only needed for workflow_dispatch
```

That's it. The action installs Node + ffmpeg + Playwright, builds tik-test, auto-detects the PR number and preview URL from the triggering event, runs the review, and posts the video back to the PR.

### Inputs

| Input | Required? | Default | What |
|---|---|---|---|
| `claude-code-oauth-token` | Yes¹ | — | OAuth token from `claude setup-token`. Uses your **Claude Code Max** subscription — no per-request billing. |
| `anthropic-api-key` | Yes¹ | — | Pay-per-use alternative to the OAuth token. |
| `openai-api-key` | No | — | Enables OpenAI TTS voice-over. Without it, the video is silent on Linux runners. |
| `vercel-bypass-secret` | No | — | Vercel automation bypass for protected previews. |
| `pr-number` | No | auto | Auto-detected from `pull_request`, `deployment_status`, or `workflow_dispatch` events. |
| `preview-url` | No | auto | Override target URL. Auto-detected from `deployment_status.target_url`; otherwise read from your repo's `claude.md`. |
| `review-mode` | No | `request-changes-on-fail` | `none` · `approve-on-pass` · `request-changes-on-fail` · `always`. |
| `require-pass` | No | `true` | Exit non-zero when any goal fails (turns the check red). |
| `quick` | No | `true` | Draft 540×960 render (~2 min). Set `false` for full-res. |
| `working-directory` | No | repo root | Subdirectory containing `claude.md`. Useful for monorepos. |
| `plan-timeout` | No | `240` (s) | Plan-generation Claude call timeout. Bump for huge diffs. |
| `agent-timeout` | No | `600` (s) | Per-goal agent timeout. Bump for slow page loads or PRs touching many surfaces. |
| `narration-timeout` | No | `540` (s) | Narration-generation Claude call timeout. Bump for very long runs that produce 12+ tool moments. |

> The Action exposes **9 more typed inputs** for fine-tuning — `setup-timeout`, `feature-finder-timeout`, `min-chunk-seconds`, `max-body-scenes`, `checklist-min-items`, `checklist-max-items`, `intro-seconds`, `outro-seconds`, `outro-hold-seconds`. See the [Advanced](#advanced) section below or run `node dist/cli.js config` for defaults + risks of changing.

¹ Provide one of the two — OAuth token recommended for cost control.

### Secrets to add

The action only needs **one** secret to run:

| Secret | Where it comes from |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` locally → paste into repo Settings → Secrets. |

Optional secrets (for richer output / protected previews):

| Secret | When to add |
|---|---|
| `OPENAI_API_KEY` | If you want voice-over narration. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | If your Vercel preview has Deployment Protection enabled. |
| `ANTHROPIC_API_KEY` | Pay-per-use alternative to `CLAUDE_CODE_OAUTH_TOKEN`. |

### Gating behaviour

- `review-mode: request-changes-on-fail` (default) — tik-test posts a formal **Request Changes** review when any goal fails, which blocks merges on repos requiring reviewer approval.
- `require-pass: true` (default) — the job exits non-zero when any goal fails, turning the check red.
- Set `require-pass: false` to keep the check green but rely on the formal review to flag bugs for humans.

### Self-hosted reference

This repo dogfoods the action: see [`.github/workflows/tik-test.yml`](.github/workflows/tik-test.yml). It's the same workflow as above except `uses: ./` (the local action) instead of `marcushyett/tik-test@v1`.

---

## Troubleshooting

**"Plan generation timed out after 240000ms"**
The PR diff is huge or your `claude.md` is missing. Either bump `plan-timeout: 480` in the action, or trim the diff (most useful pages are mentioned in `## Focus`).

**"Per-goal agent timed out after 600000ms"**
The agent is stuck — either the page never loaded, login is broken, or the goal is too vague. Check the action logs for the last `mcp__playwright_*` tool call. If your app is just slow, bump `agent-timeout: 1200`.

**"Narration generation timed out after 540000ms"**
You produced a very long recording (15+ tool calls). Either trim the goals, bump `narration-timeout: 900`, or set `TIK_MAX_BODY_SCENES=8` to coalesce more aggressively.

**The video is silent on the GitHub runner**
You haven't set `OPENAI_API_KEY`. Without it tik-test ships silent on Linux (macOS has a fallback `say` voice).

**The agent clicks the wrong button**
Help it: add a `## Hints` section to your `claude.md` describing the surface, or add `data-testid` attributes to the elements you care about. The plan generator sees the diff but not the rendered DOM.

**"claude: command not found"** in CI
Use the GitHub Action — it bundles the CLI install. If you're running the CLI directly outside CI, run `npm i -g @anthropic-ai/claude-code` (or use the bundled installer in your workflow).

**The PR comment shows the marker but the video is broken**
That's expected fallback behaviour: if any post-process step crashes (TTS, narration, render), tik-test still uploads the raw recording. Check the run artifacts to debug.

---

## Advanced

> 💡 **Tip:** run `node dist/cli.js config` to print every knob with its current value, default, override hint, and risks of going lower or higher — same data as below, scoped to your environment so you can see what's already overridden.

<details>
<summary><strong>Every env-var knob — defaults, rationale, and risks of changing them</strong></summary>

Everything below is a **last-resort override** — defaults are tuned for a typical PR (1-3 goals, 30-60s recording, 8-12 narration scenes, 6-10 checklist items) on a Claude Max subscription. Bump only after you've seen the corresponding default fail in your run.

**Action users:** every knob below has a matching typed input on the GitHub Action (kebab-case version of the env-var, dropping the `TIK_` prefix and `_MS` suffix). Prefer the typed input in YAML — it's friendlier to read.

### Voice / TTS

| Var | Default | Rationale | Risk if changed |
|---|---|---|---|
| `OPENAI_API_KEY` | _(unset)_ | Selecting OpenAI TTS produces a natural voice on Linux runners (where `say` doesn't exist). | Without it the video is silent in CI. |
| `TIK_TTS_VOICE` | `ash` | `ash` reads technical content clearly without sounding robotic. | Other voices may misread code identifiers or punctuation. |
| `TIK_TTS_MODEL` | `gpt-4o-mini-tts` | Cheap and fast. Higher-tier TTS doesn't measurably improve clip quality at this length. | Higher-tier = slower + more cost; lower-tier = mispronunciation. |

### Auth

| Var | Default | Rationale | Risk if changed |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | _(unset)_ | Used by the `claude` CLI as a paid fallback when the OAuth token isn't present. | Bypasses Claude Code Max — billing shifts to per-token usage. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | _(unset)_ | Attached as header + cookie so Vercel-protected previews are reachable from CI. | Without it, protected previews 404 the agent. |

### Debugging

| Var | Default | Rationale | Risk if changed |
|---|---|---|---|
| `TIK_KEEP_PUBLIC=1` | _(off)_ | Keeps the per-run `public/` directory (master MP4, voice WAVs, raw recordings). | Disk fills if you forget to clean up between runs. |
| `TIK_KEEP_CLONE=1` | _(off)_ | Keeps the temp directory tik-test clones PRs into. | Same disk caveat. |
| `TIK_FFMPEG_DEBUG=1` | _(off)_ | Prints every ffmpeg invocation. | Verbose. |
| `TIK_REMOTION_DEBUG=1` | _(off)_ | Verbose Remotion renderer logs. | Verbose. |

### Claude CLI timeouts (millisecond)

The GitHub Action exposes all five as typed seconds inputs (`plan-timeout`, `agent-timeout`, `narration-timeout`, `setup-timeout`, `feature-finder-timeout`) — prefer those in YAML. The env vars below are for direct CLI use or wiring into custom integrations.

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_PLAN_TIMEOUT_MS` | `240000` (4 min) | One-shot plan call digesting the PR diff + `claude.md`. 4 min handles a 500-line diff comfortably. | Small diffs may still take 60s+ — too low and you'll time out before plan is even drafted. | Wastes CI budget on hung Claude processes. |
| `TIK_AGENT_TIMEOUT_MS` | `600000` (10 min) | EACH per-goal browser-driving Claude call. 10 min covers a 12-tool-call goal with a slow login. | A stuck agent is rarely productive past 5 min — but a real cold start (Vercel preview waking up) can eat 90s alone. | Hung agents drain the 25-min job budget; combine with retries to hide bugs. |
| `TIK_NARRATION_TIMEOUT_MS` | `540000` (9 min) | One-shot narration call (intro + outro + every scene line). Sonnet handles ~12 scenes in 5-8 min. | Long runs (15+ scenes) regularly hit 6+ min — too low and you fall back to the "no voice" path. | Doesn't help: if Claude is wedged it stays wedged. Trim scenes via `TIK_MAX_BODY_SCENES` instead. |
| `TIK_SETUP_TIMEOUT_MS` | `60000` (1 min) | Setup-step suggester. Should always finish in <30s. | Setup may misfire on slow networks. | Wastes time when setup hangs — it's almost never doing useful work past 60s. |
| `TIK_FEATURE_FINDER_TIMEOUT_MS` | `60000` (1 min) | One-shot fallback when `startUrl` lands on a 404 — Claude tries to find a working URL. | Same. | Same. |

### Body-narration density

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_MIN_CHUNK_S` | `3.5` (seconds) | Shorter consecutive moments coalesce into the previous chunk. 3.5s gives Claude enough breathing room per scene line. | <2s = many tiny scenes = narration prompt blows up = sonnet timeouts. | >6s = scenes feel sluggish, captions repeat themselves on screen. |
| `TIK_MAX_BODY_SCENES` | `12` | Hard ceiling after coalescing. Above 12 we sample evenly so the prompt stays bounded. | <8 misses interesting moments — you'll see the agent click then jump-cut. | >14 risks the narration call timing out on a 25+ tool run; use only if you've also bumped `TIK_NARRATION_TIMEOUT_MS`. |

### Outro checklist sizing

The "AI checks" list shown on the final frame and embedded in the PR comment.

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_CHECKLIST_MIN_ITEMS` | `4` | Below 4 items the checklist looks scrappy and we treat the LLM call as failed (fall back to one row per goal). | <3 = list always looks empty even on small PRs. | >6 = LLM call frequently "fails" on tiny PRs that legitimately have only 3 things to check. |
| `TIK_CHECKLIST_MAX_ITEMS` | `10` | Empirically the largest count that stays scannable in the 9:16 outro card. Dense layout kicks in past 7. | <6 hides legitimately interesting checks. | >12 overflows the safe band — items get clipped on mobile. |

### Intro / outro card durations

| Var | Default | Rationale | Risk: lower | Risk: higher |
|---|---|---|---|---|
| `TIK_INTRO_TARGET_S` | `4.5` (seconds) | Title card window. Tells the narrator how long the intro line should be. | <3s = the title flashes by; viewers miss the PR context. | >6s = boring opening, viewers swipe away. |
| `TIK_OUTRO_TARGET_S` | `4.0` (seconds) | Outro narration window. | <3s = narrator races through the wrap-up. | >5s = drags after the action ends. |
| `TIK_OUTRO_HOLD_S` | `3.5` (seconds) | Extra time the outro Sequence holds AFTER the voice ends so the checklist stays readable. | <2s = reviewers can't finish reading. | >5s = video feels long; auto-advance laggy. |

</details>

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

**Local iteration loop:**

```sh
# 1. Change code
# 2. Rebuild
npm run build
# 3. Dogfood against the bundled example
OPENAI_API_KEY=... node dist/cli.js run --config examples/todo-app/claude.md --quick
# 4. Eyeball the video, iterate.
```

## License

MIT. See [LICENSE](LICENSE).
