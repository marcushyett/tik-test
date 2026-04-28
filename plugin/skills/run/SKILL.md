---
description: Record a TikTok-style video walkthrough of the dev server running on localhost. Use when the user asks to record a video, capture a walkthrough, or share what they just shipped. Accepts an optional URL argument.
allowed-tools: Bash, Read, Write
---

# tiktest:run

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

2. **Resolve the target URL.** Three resolution paths — remember which one you took, step 5 branches on it:
   - **(a)** If `$ARGUMENTS` starts with `http://` or `https://`, that is the URL.
   - **(b)** Else, probe each of these in order with `curl -sf -o /dev/null --max-time 1 <url>` and use the first that responds: `http://localhost:3000`, `http://localhost:5173`, `http://localhost:4173`, `http://localhost:8080`.
   - **(c)** Else, look for a `tiktest.md`, `tik-test.md`, or a `README.md` containing either a `## TikTest`/`## Testing` (or alias) heading or a bare `http://` / `https://` URL — the CLI extracts the URL from any of these. In this path no URL is resolved here — the CLI parses it from the file.
   - Else, stop and tell the user: "Couldn't find a dev server on ports 3000/5173/4173/8080, and no tiktest.md in the current directory. Either start a dev server, pass a URL as an argument (`/tiktest:run http://localhost:1234`), or add the URL to `tiktest.md` (either as a frontmatter `url:` line between `---` fences, or as a bare `http://…` / `https://…` URL anywhere in the body)."

3. **Summarise the change and announce a plan (soft confirmation).** Help the user feel that the agent understands what they just shipped — read the diff, summarise it, list what you'll exercise, then proceed. The user can interrupt with corrections mid-stream; **never** ask an explicit yes/no question.

   First, check whether this step applies at all:

   ```bash
   git rev-parse --git-dir 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null
   ```

   **Skip this entire step (proceed silently to step 4) if any of:**
   - The `git rev-parse --git-dir` command failed (cwd is not a git repo).
   - The current branch is `main` or `master` (no feature to summarise).
   - There's no diff vs `origin/main` AND no uncommitted changes — i.e. both `git diff --stat` and `git diff origin/main..HEAD --stat` print nothing.
   - You took **path (a)** in step 2 (the user passed an explicit URL as `$ARGUMENTS`). They already know what they want; don't slow them down with a plan summary.

   Otherwise, gather a quick view of the change (token-aware — don't read the full diff for large changes):

   ```bash
   # Recent commits on this branch (fall back to `main` if `origin/main` doesn't exist; skip silently if neither does)
   git log origin/main..HEAD --oneline -10 2>/dev/null || git log main..HEAD --oneline -10 2>/dev/null
   # File-level summary
   git diff origin/main..HEAD --stat 2>/dev/null
   git diff --stat
   # If the total `--stat` output suggests <200 lines changed, also grab the full diff:
   git diff origin/main..HEAD 2>/dev/null
   ```

   For larger diffs, stop at the file list and a few representative hunks — don't read the whole thing.

   Then write **one short paragraph** (~2 sentences) describing what the change appears to be. Be concrete — reference filenames, function names, route paths, UI components from the diff. Follow with **3–5 bullet points** listing the specific things you'll exercise. Generic structure (do not echo any product names from this prompt — fill in from what the diff actually shows):

   > "Looks like you've added [one-line summary referencing concrete files/symbols from the diff]. I'll exercise:
   > 1. [first thing — e.g. opening the new surface]
   > 2. [second thing — e.g. exercising the primary action with valid input]
   > 3. [third thing — e.g. an edge case the diff hints at]
   > 4. [optional fourth — e.g. error handling]
   >
   > Running now — interrupt if you want a different focus."

   **Proceed automatically.** Do not ask "should I continue?" or "is this right?" — print the summary, then move to step 4. The user retains the ability to interrupt with words mid-stream; that's the soft-confirmation contract.

4. **Set up the run directory and config.** First create a tmpdir for run output (always — used for `--out-dir` regardless of config source):

   ```bash
   TIKTEST_TMP=$(mktemp -d -t tiktest-XXXXXX)
   ```

   Then decide what `<CONFIG_PATH>` should be:

   - **If the cwd has `tiktest.md`, `tik-test.md`, or `README.md` with any of these tik-test headings: `## TikTest`, `## tik-test`, `## Testing`, `## How to Test`, `## Test Setup`, `## Test Environment`, `## Test Instructions`** (step 2 path c, OR a usable config existed alongside a resolved URL): set `<CONFIG_PATH>` to that file's absolute path.
   - **Otherwise** (paths a/b with no cwd config): use the Write tool (which is in `allowed-tools`, so shell metacharacters in `$ARGUMENTS` aren't expanded) to create a config file at `${TIKTEST_TMP}/tiktest.md` with this content:

     ```
     ---
     url: <RESOLVED_URL>
     ---

     Auto-generated config from /tiktest:run. Explore the primary surface and exercise the main user-facing actions. <ARGUMENTS_IF_NOT_URL>
     ```

     Substitute `<RESOLVED_URL>` with the URL you resolved in step 2. Substitute `<ARGUMENTS_IF_NOT_URL>` with the literal text of `$ARGUMENTS` only if it didn't itself look like a URL — otherwise drop that line entirely. The Write tool writes the content as-is, so no shell expansion occurs. Set `<CONFIG_PATH>` to `${TIKTEST_TMP}/tiktest.md`.

5. **Run the CLI.** Use the `tik-test` binary on PATH (installed via `npm install -g tik-test`) — version-locked with the plugin you're running. Do **not** use `npx -y tik-test@latest` (that would fetch a different version than the plugin and defeat the reuse principle).

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

   Stream the output back to the user as it runs. The CLI prints four numbered phases (plan, run, checklist, edit) and lands on a `✓ done` line with the path to the produced MP4.

6. **Move the MP4 to a stable, user-visible location.**

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

7. **Report back** with two parts: (a) the absolute path to the MP4 (e.g. `~/Desktop/tiktest-<timestamp>.mp4`) plus one line describing what the walkthrough shows, and (b) the checklist as printed by the CLI in stdout — copy the section ending with the `N checks · M passed · K failed · J skipped` summary line, including the labelled `✓` / `✗` / `·` rows above it, so the user (or their agent) can immediately see what passed, what failed, and start fixing failures.

## What NOT to do

- Do not invent a URL the user didn't give you and the probe didn't find.
- Do not retry the CLI on failure — surface the CLI's own error message verbatim and stop. The CLI's errors are already actionable.
- Do not delete `$TIKTEST_TMP` until after the MP4 has been moved successfully — the run logs are useful if the move fails.
