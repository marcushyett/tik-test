<div align="center">

# 🎬 tik-test

**Automated TikTok-style video reviews for your PRs.**

Point it at a pull request, it signs in, clicks around, tries to break things, and posts a narrated 9:16 video that explains what the feature does, exercises it exhaustively, and calls out bugs on camera — like a colleague walking you through their change on a screen-share.

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](package.json)
[![Runs on macOS + Linux](https://img.shields.io/badge/runs_on-macOS%20%7C%20Linux-black)](#install)

</div>

---

## Why

Reviewing a UI PR is exhausting. You have to pull the branch, run the app, sign in, click through five flows, and hope you caught the regression. Most reviewers just look at the screenshots and LGTM.

tik-test is an experiment: what if every PR showed up with a **45-second TikTok-style video** where someone (your AI colleague) actually uses the feature, narrates why it was built, tests the edges, and flags anything that looks off?

- **Exhaustive, not minimum-path** — the test plan deliberately repeats actions, tries edge cases, and regression-probes features adjacent to the change.
- **Problem-first narration** — the voiceover opens by explaining *why* the feature exists (pulled from the PR body), then refers back to that problem while demonstrating.
- **Honest on bugs** — if something breaks, the narrator says *"oops"* on camera. The video ends asking for feedback, not declaring a ship.
- **Gated in CI** — the GitHub Action runs `tik-test` after your preview deploy succeeds, posts the video, and **requests changes on the PR if anything failed**.

## Demo

**What the output looks like** (v12, 52s, Taskpad dogfood):

```
~/Desktop/tik-test-v12.mp4
```

**Real-world PR review:** [yolodex-ai/personadex#282](https://github.com/yolodex-ai/personadex/pull/282#issuecomment-4301341770) — 19/19 steps green through a Theater-mode flow (magic-link sign-in → Inspiration grid → `▶ Theater` → ↓ → S → Esc).

---

## How it works

```
                    ┌──────────────┐
                    │  claude.md   │◄── PR body, config, optional inline test plan
                    └──────┬───────┘
                           ▼
     ┌─────────────────────────────────────────────┐
     │ 1. Plan           exhaustive, exploratory   │  ← Claude generates
     │ 2. Play           Playwright runs the plan  │  ← records raw.webm
     │ 3. Narrate        Claude writes the script  │  ← intro → problem → beats → outro
     │ 4. Voice          OpenAI TTS (voice: ash)   │  ← one WAV per beat
     │ 5. Trim           FFmpeg crops idle waits   │  ← login spinners → 0.3s
     │ 6. Compose        Remotion overlays         │  ← pan/zoom, captions, clicks, audio
     │ 7. Publish        GitHub release + comment  │  ← + formal PR review (approve/reject)
     └─────────────────────────────────────────────┘
                           ▼
                  `highlights.mp4` + `preview.gif`
```

**Key design decisions:**

- **One continuous master video**, not per-step clips. Every overlay (audio, caption, cursor, click flash, pan/zoom) references the same timeline so desync is structurally impossible.
- **Voice is the source of truth for pacing.** Each beat's window is sized to its narration, then the audio's playbackRate is clamped (1.0–1.6x) so a too-long line never bleeds into the next beat.
- **Remotion is compositor-only.** Zoom and pan are simple CSS transforms over the pre-trimmed master — Chrome stays hot, render is ~20 fps on Apple Silicon in `--quick` mode.

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
| `--require-pass` | Exit non-zero if any step failed (for CI gating) |
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
# start: prefix runs this as a background process before tests

## Test Plan  (optional — omit to let Claude generate one)
```json
{
  "name": "...",
  "startUrl": "...",
  "steps": [
    { "id": "open", "kind": "navigate", "description": "...", "target": "..." },
    { "id": "assert-counter", "kind": "assert-text", "target": "[data-testid=counter]", "value": "0 tasks" }
  ]
}
```
```

**Step kinds:** `navigate`, `click`, `fill`, `press`, `hover`, `wait`, `assert-visible`, `assert-text`, `screenshot`, `script`.

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
  contents: read
  pull-requests: write                  # for comments + review submissions

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
| `require-pass` | No | `true` | Exit non-zero when any test step fails (turns the check red). |
| `quick` | No | `true` | Draft 540×960 render (~2 min). Set `false` for full-res. |

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

- `review-mode: request-changes-on-fail` (default) — tik-test posts a formal **Request Changes** review when any step fails, which blocks merges on repos requiring reviewer approval.
- `require-pass: true` (default) — the job exits non-zero when any step fails, turning the check red.
- Set `require-pass: false` to keep the check green but rely on the formal review to flag bugs for humans.

### Self-hosted reference

This repo dogfoods the action: see [`.github/workflows/tik-test.yml`](.github/workflows/tik-test.yml). It's the same workflow as above except `uses: ./` (the local action) instead of `marcushyett/tik-test@v1`.

---

## Environment variables

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | Selects OpenAI TTS (`gpt-4o-mini-tts`, voice `ash`, speed 1.35). |
| `TIK_TTS_VOICE` | Override OpenAI voice (default `ash`). |
| `TIK_TTS_MODEL` | Override TTS model (default `gpt-4o-mini-tts`). |
| `ANTHROPIC_API_KEY` | Used by the `claude` CLI and future SDK-based plan/story generation. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Attached as header + cookie so Vercel-protected previews are reachable. |
| `TIK_KEEP_PUBLIC=1` | Keep the per-run `public/` directory (master MP4, voice WAVs) for debugging. |
| `TIK_KEEP_CLONE=1` | Keep the temp directory tik-test clones PRs into. |
| `TIK_FFMPEG_DEBUG=1` | Print every ffmpeg invocation. |
| `TIK_REMOTION_DEBUG=1` | Verbose logs from the Remotion renderer. |

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
