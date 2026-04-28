---
description: Record a TikTok-style video walkthrough of the dev server running on localhost. Use when the user asks to record a video, capture a walkthrough, or share what they just shipped. Accepts an optional URL argument.
allowed-tools: Bash, Read, Write
---

# tiktest:record

The user wants a short MP4 walkthrough of whatever's running locally. Drive the `tik-test` CLI to produce one and drop it on their Desktop.

## Argument

`$ARGUMENTS` — optional. If non-empty and looks like a URL (starts with `http://` or `https://`), use it as the target. Otherwise treat as freeform context for what to focus the video on.

## Steps

1. **Preflight check prerequisites.** Run all four checks in parallel and collect any failures before doing anything else:

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
   - Else, stop and tell the user: "Couldn't find a dev server on ports 3000/5173/4173/8080, and no tiktest.md in the current directory. Either start a dev server, pass a URL as an argument (`/tiktest:record http://localhost:1234`), or add the URL to `tiktest.md` (either as a frontmatter `url:` line between `---` fences, or as a bare `http://…` / `https://…` URL anywhere in the body)."

3. **Ensure a config file.** The CLI reads its instructions from a markdown file. If the cwd already has `tiktest.md`, `tik-test.md`, or a `README.md` with a `## TikTest` (or `## Testing`) heading, use it directly via `--config`. Otherwise generate a minimal temporary config — **use the Write tool** (which is in `allowed-tools`) so shell metacharacters in `$ARGUMENTS` aren't expanded:

   ```bash
   TIKTEST_TMP=$(mktemp -d -t tiktest-XXXXXX)
   ```

   Then call the Write tool with `file_path` set to `${TIKTEST_TMP}/tiktest.md` and `content` set to:

   ```
   ---
   url: <RESOLVED_URL>
   ---

   Auto-generated config from /tiktest:record. Explore the primary surface and exercise the main user-facing actions. <ARGUMENTS_IF_NOT_URL>
   ```

   Substitute `<RESOLVED_URL>` with the URL you resolved in step 2 (paths a or b). Substitute `<ARGUMENTS_IF_NOT_URL>` with the literal text of `$ARGUMENTS` only if it didn't itself look like a URL — otherwise drop that line entirely. The Write tool writes the content as-is, so no shell expansion occurs.

   (This branch is only reachable when you resolved a URL in step 2 paths a or b. If you fell through to path c, skip this step — the existing config file is the config.)

4. **Run the CLI.** Use the `tik-test` binary on PATH (installed via `npm install -g tik-test`) — version-locked with the plugin you're running. Do **not** use `npx -y tik-test@latest` (that would fetch a different version than the plugin and defeat the reuse principle).

   - **If you resolved a URL in step 2 (paths a or b)**, pass it explicitly:

     ```bash
     tik-test run \
       --config "<CONFIG_PATH>" \
       --out-dir "$TIKTEST_TMP/runs" \
       --url "<RESOLVED_URL>"
     ```

   - **If you fell through to step 2 path c** (existing `tiktest.md` / `tik-test.md` / `README.md` in cwd), omit `--url` so the CLI extracts it from the config file:

     ```bash
     tik-test run \
       --config "<CONFIG_PATH>" \
       --out-dir "$TIKTEST_TMP/runs"
     ```

   Stream the output back to the user as it runs. The CLI prints three numbered phases (plan, run, edit) and lands on a `✓ done` line with the path to the produced MP4.

5. **Move the MP4 to a stable, user-visible location.**

   ```bash
   STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
   if [ "$(uname)" = "Darwin" ] && [ -d "$HOME/Desktop" ]; then
     OUT="$HOME/Desktop/tiktest-$STAMP.mp4"
   else
     OUT="$HOME/tiktest-$STAMP.mp4"
   fi
   FOUND=$(find "$TIKTEST_TMP/runs" -name "highlights.mp4" -print -quit)
   if [ -z "$FOUND" ]; then
     echo "No highlights.mp4 produced — see logs in $TIKTEST_TMP/runs"
     exit 1
   fi
   mv "$FOUND" "$OUT"
   echo "$OUT"
   ```

6. **Report back** with one line: the absolute path to the MP4 and a single sentence describing what it shows (read this from the run's `events.json` if you want, but a generic "Walkthrough recorded — open in any video player." is fine).

## What NOT to do

- Do not invent a URL the user didn't give you and the probe didn't find.
- Do not retry the CLI on failure — surface the CLI's own error message verbatim and stop. The CLI's errors are already actionable.
- Do not delete `$TIKTEST_TMP` until after the MP4 has been moved successfully — the run logs are useful if the move fails.
