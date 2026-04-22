# tik-test

**TikTok-style automated video reviews for your UI changes.**

Point `tik-test` at a running app (or a GitHub pull request) and it:

1. Generates an end-to-end test plan — either from a `claude.md` in the repo or by calling `claude -p`.
2. Runs the plan in a headless Chromium browser via Playwright, recording the session.
3. Edits the recording into a 9:16 highlight reel: slow-mo on critical beats, ken-burns zoom onto the element being interacted with, narrative captions, and a macOS `say` voice-over.
4. Posts the resulting video back to the PR so reviewers see *exactly* what changed — without having to reproduce it themselves.

> Status: MVP. It's open source; contributions very welcome.

---

## What it looks like

Each step becomes a short beat in a vertical video:

- **Top chip** — step index + kind (TAP · 9/18) or importance (CRITICAL BEAT / IMPORTANT).
- **Centered browser band** with a blurred cover behind so the composition fills 1080×1920.
- **Ken-burns zoom** centered on the element Playwright clicked / filled / asserted on.
- **Large bottom caption** — what this step is doing, in human language.
- **Voice-over** — a friendly narration that explains the action (macOS `say`).
- **Red frame + slow-mo** on any failing step.
- **Title + summary cards** bookend the reel with the run status.

There's also a web viewer at `tik-test view` — lets you scrub the timeline, flag specific steps, and copy a Claude-ready feedback prompt to paste back into `claude -p`.

## Quick start

```sh
brew install ffmpeg
npm install
npx playwright install chromium

# run against a local app described by ./claude.md
npm run build
node dist/cli.js run --config claude.md --open

# try the bundled demo: spin up the Taskpad example
python3 -m http.server 4173 --directory examples/todo-app &
node dist/cli.js run --config examples/todo-app/claude.md
open runs/<latest>/highlights.mp4
```

## `claude.md` configuration

`tik-test` reads a markdown file with optional YAML frontmatter and named sections:

```md
---
name: My feature
viewport: 900x760
music: ./music/bed.mp3
---

## URL
https://my-preview.vercel.app

## Setup
start: npm run dev
# `start:` prefix means "run this as a background process before tests".

## Focus
Describe the PR / what's risky / what reviewers should watch for.
Claude uses this to build a smarter test plan when no plan is provided.

## Test Plan  (optional — if omitted, `claude -p` is called to generate one)
```json
{
  "name": "...",
  "startUrl": "...",
  "steps": [
    { "id": "open", "kind": "navigate", "description": "Open app", "target": "https://..." },
    { "id": "click-cta", "kind": "click", "description": "Tap the primary CTA", "target": "[data-testid=cta]", "importance": "critical" },
    { "id": "see-flash", "kind": "assert-visible", "description": "Success toast appears", "target": "[data-testid=toast].show", "importance": "high" }
  ]
}
```
```

**Step kinds**

| kind | shape | notes |
|---|---|---|
| `navigate` | `{ target: url }` | absolute or relative to `startUrl` |
| `click` | `{ target: selector }` | CSS, Playwright `role=button[name=…]`, or `text=…` |
| `fill` | `{ target, value }` | input text |
| `press` | `{ target?, value: key }` | e.g. `Enter` |
| `hover` | `{ target }` | |
| `wait` | `{ value: ms }` | |
| `assert-visible` | `{ target }` | |
| `assert-text` | `{ target, value }` | substring match |
| `screenshot` | `{ }` | screenshots go to `runs/<id>/screenshots/` |
| `script` | `{ value: js }` | evaluated in the page via `page.evaluate` |

**Importance** — `normal` (default), `high`, or `critical`. Drives the slow-mo factor, the colored border, and the badge chip in the video.

## GitHub PR mode

```sh
tik-test pr https://github.com/owner/repo/pull/123
# or, inside a repo:
tik-test pr 123
```

What it does:

1. Resolves the PR via `gh pr view`.
2. Clones the head repo + checks out the PR branch into a temp dir.
3. Finds a config (`claude.md` → `CLAUDE.md` → `.claude/claude.md` → `tik-test.md` → `README.md`).
4. If the PR body/comments contain a Vercel or Netlify preview URL, it's used as the target; otherwise the `Setup: start: …` command in `claude.md` spins up a dev server and we poll until the URL is live.
5. Runs the pipeline end-to-end.
6. Uploads the video to a GitHub release (tagged `tik-test-reviews-pr<N>-<timestamp>`, `--prerelease`).
7. Posts a PR comment with an inline `<video>` embed + link to the asset + the step list.
8. Adds the `tik-test-reviewed` label (best-effort).

Useful flags:

- `--skip-clone` — run against the current working directory instead of cloning.
- `--skip-comment` — render the video but don't post (great for dry runs).
- `--asset-repo owner/repo` — upload the release to a different repo (e.g. a dedicated review repo).
- `--url <url>` — override preview URL detection.
- `--no-voice` — render without narration.

Prerequisites: `gh auth login` with access to the PR repo + write scope if you want comments/labels; a viable `claude.md` in the target repo.

## Architecture

```
claude.md ─┬─> plan generator (inline plan || claude -p)
           │
           └─> Playwright runner (records .webm, captures bboxes + outcomes per step)
                    │
                    └─> FFmpeg editor
                          · slices per step, sets playback speed by importance / outcome
                          · zoompan ken-burns centered on the recorded bbox
                          · blurred cover + centered fg in 1080x1920
                          · drawtext captions from the narrator
                          · macOS `say` voice-over per segment, mixed with optional music
                          · concat filter produces `highlights.mp4`
                          └─> viewer (`tik-test view`) or PR comment (`tik-test pr`)
```

## Development

```sh
npm run dev  -- run examples/todo-app/claude.md   # run via tsx
npm run build                                     # compile to dist/
npm run typecheck
```

Runs are written to `./runs/<run-id>/`:
- `raw.webm` — the recording.
- `highlights.mp4` — the final cut.
- `events.json` — step-by-step timestamps, outcomes, bboxes.
- `plan.json` — the plan that was executed.
- `screenshots/` — captures for critical/high-importance and failing steps.

## Environment variables

- `TIK_KEEP_SEGMENTS=1` — keep per-segment intermediate mp4s under `runs/<id>/segments/` for debugging.
- `TIK_KEEP_CLONE=1` — keep the PR clone temp directory around after a run.
- `TIK_FFMPEG_DEBUG=1` — print every ffmpeg invocation (very useful when a filter graph breaks).
- `TIK_RUNS_DIR=/path` — override the runs directory when starting the viewer directly (`node dist/viewer.js`).

## Roadmap

- Per-step zoom keyframes (approach wide → focus tight) instead of a single ease-in.
- Use Claude CLI to author richer narration (current narration is template-based).
- Inline frame captions generated via Whisper on the voice track, for platforms that don't autoplay audio.
- Official GitHub Action wrapper so reviews happen automatically on every PR open / re-request.
- Dev-server orchestration that shares state across multiple PRs under review in parallel.

## License

MIT — please do open issues and PRs. The spec that motivated this lives in [issue #1](https://github.com/marcushyett/tik-test/issues/1).
