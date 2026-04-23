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

## GitHub Action: run after every preview deploy

`.github/workflows/tik-test.yml` (copy from this repo; ready to drop in):

```yaml
on:
  deployment_status:           # triggers after Vercel/Netlify preview is Ready
  workflow_dispatch:
    inputs: { pr_number: { required: true } }

permissions:
  contents: read
  pull-requests: write          # needed for comments + review submissions

jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: sudo apt-get install -y ffmpeg fonts-dejavu && npx playwright install chromium --with-deps

      # Anthropic's action authenticates Claude Code via your Max subscription.
      # Generate the token with: `claude setup-token`
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

      - run: |
          git clone --depth 1 https://github.com/marcushyett/tik-test /tmp/tik-test
          cd /tmp/tik-test && npm ci --omit=dev && npm run build

      - env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node /tmp/tik-test/dist/cli.js pr "<PR_NUMBER>" \
            --review request-changes-on-fail \
            --require-pass \
            --quick
```

### Secrets you'll need

| Secret | Where it comes from | Required? |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` locally, paste the token into repo secrets. Uses your **Claude Code Max** subscription — no per-request billing. | Recommended |
| `ANTHROPIC_API_KEY` | Pay-per-use alternative if you'd rather not use the subscription token. | Either/or |
| `OPENAI_API_KEY` | Voice-over via `gpt-4o-mini-tts` (voice `ash`). Falls back to macOS `say` locally; silent on Linux if unset. | Optional |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | From Vercel → Project Settings → Deployment Protection → "Protection Bypass for Automation" → "Generate". | Only if your preview is protected |

### Gating behaviour

- `--review request-changes-on-fail` (default): tik-test posts a formal **Request Changes** review when any step fails, which blocks merges on repos that require reviewer approval.
- `--require-pass`: the job exits non-zero when any step fails, turning the check red.
- Use both together for strict gating, or just `--review` to keep the check green but require human attention on bugs.

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
