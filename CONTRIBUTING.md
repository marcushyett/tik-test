# Contributing to tik-test

Thanks for wanting to help. tik-test is experimental and very much open to changes.

## Local setup

```sh
brew install ffmpeg
npm install
npx playwright install chromium
npm run build      # compile TS → dist/
npm run typecheck  # no emit
```

A macOS host is the smoothest path: we use the system `say` voice as a fallback, and Remotion's headless Chrome is well-exercised there. Linux works too as long as `ffmpeg`, `chromium`, and a bold system font are reachable.

## Layout

- `src/` — the Node CLI, Playwright runner, FFmpeg editors, Remotion renderer glue, PR integration.
- `remotion/` — the React compositions rendered by Remotion (`SingleVideoReel` is the current default).
- `examples/todo-app/` — a small demo app (`Taskpad`) used for dogfooding end-to-end.
- `viewer/` — the static web viewer served by `tik-test view`.

## Running locally

```sh
# start the demo app + run a pass against it
node examples/todo-app/server.js &
node dist/cli.js run --config examples/todo-app/tiktest.md --quick

# view the produced video
open ~/Desktop/tik-test-*.mp4
```

`--quick` is your friend during iteration — it renders at 540×960 @ 8× concurrency and typically finishes in 2–3 minutes for a 40s reel on Apple Silicon.

## Voice-over

- If `OPENAI_API_KEY` is set, we use OpenAI `gpt-4o-mini-tts` (voice `ash`, `speed: 1.35`). Set `TIK_TTS_VOICE` / `TIK_TTS_MODEL` to override.
- If no key is set, we fall back to macOS `say` (voice `Samantha` by default, override with `--voice <name>`).

## Open-source-readiness checklist

- [x] MIT licensed.
- [x] Runs on any arbitrary repo that has a `tiktest.md` (or `claude.md` / `CLAUDE.md` / `README.md`) with a `## URL`.
- [x] Works behind Vercel Protection via `--vercel-bypass <secret>` or `VERCEL_AUTOMATION_BYPASS_SECRET` env.
- [x] Single-video pipeline — no per-step clip slicing, so narration can't desync from the footage.
- [x] GitHub Action wrappers under `.github/workflows/` (`tik-test-taskpad.yml`, `tik-test-webapp.yml`).
- [ ] Pluggable TTS providers (Eleven Labs, Azure, local Piper).
- [ ] Pluggable story generator (any LLM, not just `claude -p`).
- [ ] A proper matrix of fixtures so iterative rendering is reproducible across hosts.

## Sending a patch

1. Branch from `main`.
2. Run `npm run typecheck`.
3. Run tik-test against the bundled `examples/todo-app` to make sure your change doesn't regress the reel.
4. Open a PR — ideally attach a tik-test video of your change using `tik-test pr <your-pr-url>` (meta!).

Small PRs welcome. This is a playful tool; we want to keep it fun.
