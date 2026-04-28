---
description: Run tik-test in checks-only mode (no video render) and print the checklist. Use when the user wants a fast, cheap pass over the running app — no MP4 produced.
allowed-tools: Bash, Read, Write
---

# tiktest:checks

The user wants a fast, cheap pass over whatever's running locally — same agent run as `/tiktest:record` but without rendering a video; output is a chat-printed checklist.

## Argument

`$ARGUMENTS` — optional. If non-empty and looks like a URL (starts with `http://` or `https://`), use it as the target. Otherwise treat as freeform context for what to focus the run on.

## Steps

1. **Preflight check prerequisites.** Run all four checks in parallel and collect any failures before doing anything else. (`ffmpeg` isn't strictly needed in `--no-video` mode, but check it anyway for consistency with `/tiktest:record` — the same install gives you both.)

   ```bash
   command -v tik-test || echo "MISSING tik-test"
   command -v claude   || echo "MISSING claude"
   command -v ffmpeg   || echo "MISSING ffmpeg"
   # Chromium binary check — Playwright stores under ~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux:
   ls "$HOME/Library/Caches/ms-playwright"/chromium-*/ 2>/dev/null || ls "$HOME/.cache/ms-playwright"/chromium-*/ 2>/dev/null || echo "MISSING chromium"
   ```

   If any line printed `MISSING …`, stop and surface a single actionable message:

   - `MISSING tik-test` → "Install the CLI: `npm install -g tik-test`"
   - `MISSING claude` → "Install Claude Code: <https://docs.claude.com/en/docs/claude-code/setup>"
   - `MISSING ffmpeg` → "Install ffmpeg: `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux)"
   - `MISSING chromium` → "Install the Playwright browser: `npx playwright install chromium`"

   Do not proceed if anything is missing.

2. **Resolve the target URL.** Three resolution paths — remember which one you took, step 4 branches on it:
   - **(a)** If `$ARGUMENTS` starts with `http://` or `https://`, that is the URL.
   - **(b)** Else, probe each of these in order with `curl -sf -o /dev/null --max-time 1 <url>` and use the first that responds: `http://localhost:3000`, `http://localhost:5173`, `http://localhost:4173`, `http://localhost:8080`.
   - **(c)** Else, look for a `tiktest.md`, `tik-test.md`, or `README.md` in the current working directory and pass it through as the config (the CLI extracts the URL from there). In this path no URL is resolved here — the CLI parses it from the file.
   - Else, stop and tell the user: "Couldn't find a dev server on ports 3000/5173/4173/8080, and no tiktest.md in the current directory. Either start a dev server, pass a URL as an argument (`/tiktest:checks http://localhost:1234`), or add the URL to `tiktest.md` (either as a frontmatter `url:` line between `---` fences, or as a bare `http://…` / `https://…` URL anywhere in the body)."

3. **Set up the run directory and config.** First create a tmpdir for run output (always — used for `--out-dir` regardless of config source):

   ```bash
   TIKTEST_TMP=$(mktemp -d -t tiktest-XXXXXX)
   ```

   Then decide what `<CONFIG_PATH>` should be:

   - **If the cwd has `tiktest.md`, `tik-test.md`, or `README.md` with a `## TikTest` (or `## Testing`) heading** (step 2 path c, OR a usable config existed alongside a resolved URL): set `<CONFIG_PATH>` to that file's absolute path.
   - **Otherwise** (paths a/b with no cwd config): use the Write tool (which is in `allowed-tools`, so shell metacharacters in `$ARGUMENTS` aren't expanded) to create a config file at `${TIKTEST_TMP}/tiktest.md` with this content:

     ```
     ---
     url: <RESOLVED_URL>
     ---

     Auto-generated config from /tiktest:checks. Exercise the primary surface. <ARGUMENTS_IF_NOT_URL>
     ```

     Substitute `<RESOLVED_URL>` with the URL you resolved in step 2. Substitute `<ARGUMENTS_IF_NOT_URL>` with the literal text of `$ARGUMENTS` only if it didn't itself look like a URL — otherwise drop that line entirely. The Write tool writes the content as-is, so no shell expansion occurs. Set `<CONFIG_PATH>` to `${TIKTEST_TMP}/tiktest.md`.

4. **Run the CLI in checks-only mode.** Use the `tik-test` binary on PATH (installed via `npm install -g tik-test`) — version-locked with the plugin you're running. Do **not** use `npx -y tik-test@latest` (that would fetch a different version than the plugin and defeat the reuse principle). Both branches must pass `--no-video` so the CLI skips the Remotion render and only emits the checklist.

   - **If you resolved a URL in step 2 (paths a or b)**, pass it explicitly:

     ```bash
     tik-test run \
       --config "<CONFIG_PATH>" \
       --out-dir "$TIKTEST_TMP/runs" \
       --url "<RESOLVED_URL>" \
       --no-video
     ```

   - **If you fell through to step 2 path c** (existing `tiktest.md` / `tik-test.md` / `README.md` in cwd), omit `--url` so the CLI extracts it from the config file:

     ```bash
     tik-test run \
       --config "<CONFIG_PATH>" \
       --out-dir "$TIKTEST_TMP/runs" \
       --no-video
     ```

   Stream the output back to the user as it runs. The CLI prints its planned phases and lands on a `✓ done` (or `✗`) summary line.

5. **Surface the checklist.** Relay the CLI's printed checklist back to the user verbatim — the `✓` (passed), `✗` (failed), and `·` (skipped / not-attempted) lines are the whole point of this command. Mention the path to the run's `events.json` so the user can dig into raw tool-use events if they want more than the summary. The events.json lives at the path printed by:

   ```bash
   find "$TIKTEST_TMP/runs" -name "events.json" -print -quit
   ```

   Pass that path back to the user.

## What NOT to do

- Do not produce an MP4 — `--no-video` is the whole point of this command. If you find yourself moving an `.mp4` file anywhere, you've got the wrong skill; use `/tiktest:record`.
- Do not retry the CLI on failure — surface the CLI's own error message verbatim and stop. The CLI's errors are already actionable.
