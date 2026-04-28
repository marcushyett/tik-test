# Claude Code Plugin (issue #15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship tik-test as a Claude Code plugin so any user inside Claude Code can run a slash command (or invoke a sub-agent) to record a TikTok-style walkthrough of whatever's running locally — no GitHub PR required.

**Architecture:** A new `plugin/` directory at the repo root contains a Claude Code plugin per the current spec (`.claude-plugin/plugin.json` + `skills/` + `agents/`). Each skill is a markdown file whose body instructs Claude how to (a) preflight-check prerequisites, (b) discover the dev-server URL, (c) generate a minimal `tiktest.md` if cwd lacks one, and (d) shell out to `tik-test run …` (the CLI binary on PATH from the same package install) then move the resulting MP4 to `~/Desktop`. The plugin is a **thin instruction-layer wrapper** around the existing CLI — no new TypeScript, no new runtime deps, no changes to `src/`. Marketplace publication is documented but manual (the official marketplace requires an in-app submission form).

**Reuse principle (per maintainer ask):**

The plugin **must not** duplicate or fork any logic from `src/`. All test execution (`runner.ts`), agent driving (`goal-agent.ts`), plan generation (`plan.ts`), checklist synthesis (`checklist.ts`), and video editing (`single-video-editor.ts`, `remotion/`) is reached exclusively by invoking the `tik-test` binary via Bash. Any future change to the CLI, agent behaviour, or video pipeline propagates to the GitHub Action *and* the plugin without code edits — they are equivalent consumers of the same binary. The plugin's only job is "call the CLI with sane defaults from the right cwd and put the output where the user can find it."

**Dependency / bundling reality (per maintainer ask):**

Claude Code plugins ship markdown, not binaries — so we cannot literally bundle Playwright, ffmpeg, or browsers inside `plugin/`. But we don't have to: the dependency chain already does the right thing.

- `npm install -g tik-test` installs the npm tarball, which contains (a) the `tik-test` binary, (b) `playwright`, `@playwright/mcp`, `@remotion/*`, `commander`, etc. as transitive deps, and (c) the `plugin/` directory itself (after Task 5 adds `plugin/` to the `files` whitelist).
- The goal-agent invokes Playwright MCP via `npx -y @playwright/mcp@latest` at runtime (`src/goal-agent.ts:185`), so MCP wiring is the CLI's concern, not the plugin's. The plugin's `.mcp.json` is intentionally NOT used — that would expose Playwright MCP to the *parent* Claude Code session, which is the wrong layer (we want it in the spawned `claude` subprocess inside `tik-test`, where the CLI already configures it).
- Two pieces genuinely cannot ship via npm: the Playwright Chromium binary (~150 MB, fetched via `npx playwright install chromium`) and `ffmpeg` (system binary). The skill's preflight detects both and prints copy-pasteable install commands before doing anything expensive.

**Tech Stack:**
- Claude Code plugin spec (current — `.claude-plugin/plugin.json`, `skills/<name>/SKILL.md`, `agents/<name>.md`)
- Existing tik-test CLI (`dist/cli.js`, exposed via npm bin `tik-test`)
- npm `files` whitelist (so `plugin/` ships in the published tarball)
- Pure markdown — no build step for the plugin itself

**Scope (per issue #15):**
- ✅ Phase 1 (slash commands + sub-agent + docs)
- ❌ Phase 2 (MCP server) — deferred, separate issue
- ❌ Phase 3 (`/tiktest:init` and `/tiktest:config`) — deferred

**Naming decisions (resolved during planning):**
- Plugin name: `tiktest` (no hyphen). Plugin skills are *always* namespaced `/<plugin-name>:<skill-name>` per the current spec, so the issue's `/tiktest` becomes `/tiktest:run` / `/tiktest:quick`. Plugin name `tiktest` keeps the namespace tight; `tik-test` would give `/tik-test:run` which reads worse.
- Two skills (`run` and `quick`) instead of one with a `--no-video` arg. Cleaner mental model for the user; argument-parsing inside `$ARGUMENTS` is fiddly and the two flows produce visibly different output (MP4 vs printed checklist).
- Output: `~/Desktop/tiktest-<ISO-timestamp>.mp4` on macOS, `~/tiktest-<ISO-timestamp>.mp4` on Linux (Desktop convention is mac-specific).
- Sub-agent: a single `tiktest-runner` agent that can do either flow based on its prompt — same shell-out logic but invocable as a Task from any session.

---

## Pre-flight

**Branch from main, not the current local branch (which has already been merged upstream as of c2d5efb).**

- [ ] **Step 0a: Verify cwd is the tik-test repo root and main is up to date**

```bash
git rev-parse --show-toplevel
git fetch origin --quiet
git log origin/main -1 --oneline
```

Expected: prints `/Users/marcushyett/dev/tik-test` and a commit on `main`.

- [ ] **Step 0b: Create a fresh worktree off origin/main**

```bash
git worktree add ../tik-test-plugin -b feat/claude-code-plugin origin/main
cd ../tik-test-plugin
```

Expected: working tree at `../tik-test-plugin` on a new branch `feat/claude-code-plugin`. All subsequent steps run from inside that worktree.

---

## File Structure

Files **created** under the new worktree (`../tik-test-plugin/`):

| Path | Responsibility |
| --- | --- |
| `plugin/.claude-plugin/plugin.json` | Plugin manifest (name, version, description, author, repo URL). |
| `plugin/skills/run/SKILL.md` | `/tiktest:run` — produces an MP4 walkthrough on Desktop. |
| `plugin/skills/quick/SKILL.md` | `/tiktest:quick` — runs `--no-video` and prints the checklist. |
| `plugin/agents/tiktest-runner.md` | Sub-agent definition; invocable via Task in any Claude Code session. |
| `docs/PLUGIN.md` | Install + first-run walkthrough; how to publish to the marketplace. |

Files **modified**:

| Path | Change |
| --- | --- |
| `package.json` | Add `"plugin/"` to the `files` whitelist so the plugin ships in the npm tarball. |
| `README.md` | Add a one-paragraph "Use from Claude Code" section linking to `docs/PLUGIN.md`. |

No changes to `src/`, `dist/`, `action.yml`, or any existing CLI behaviour.

---

## Task 1: Plugin manifest

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1.1: Create the manifest directory**

```bash
mkdir -p plugin/.claude-plugin
```

- [ ] **Step 1.2: Write the manifest**

```json
{
  "name": "tiktest",
  "description": "Record a TikTok-style video walkthrough of your local dev server using the tik-test CLI.",
  "version": "0.1.0",
  "author": {
    "name": "Marcus Hyett",
    "email": "marc.hyett@gmail.com"
  },
  "homepage": "https://github.com/marcushyett/tik-test#readme",
  "repository": "https://github.com/marcushyett/tik-test"
}
```

- [ ] **Step 1.3: Validate JSON parses**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('plugin/.claude-plugin/plugin.json','utf8')).name)"
```

Expected: prints `tiktest`.

- [ ] **Step 1.4: Commit**

```bash
git add plugin/.claude-plugin/plugin.json
git commit -m "feat(plugin): add Claude Code plugin manifest"
```

---

## Task 2: `/tiktest:run` skill

**Files:**
- Create: `plugin/skills/run/SKILL.md`

The skill body is the prompt Claude reads when the user invokes the slash command. It must (1) preflight-check prerequisites, (2) probe localhost ports for a running dev server (or honour `--url <url>` if the user passed one), (3) ensure a `tiktest.md` exists in cwd or generate a minimal temp config, (4) shell out to `tik-test run` (the binary on PATH from `npm install -g tik-test`) with the right flags, (5) move the resulting MP4 to `~/Desktop` (or `~/` on Linux), (6) print the path back to the user. **Domain-agnostic per CLAUDE.md hard rules** — no product-specific examples.

- [ ] **Step 2.1: Create the skill directory**

```bash
mkdir -p plugin/skills/run
```

- [ ] **Step 2.2: Write the skill**

```markdown
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

2. **Resolve the target URL.** Three resolution paths — remember which one you took, step 4 branches on it:
   - **(a)** If `$ARGUMENTS` starts with `http://` or `https://`, that is the URL.
   - **(b)** Else, probe each of these in order with `curl -sf -o /dev/null --max-time 1 <url>` and use the first that responds: `http://localhost:3000`, `http://localhost:5173`, `http://localhost:4173`, `http://localhost:8080`.
   - **(c)** Else, look for a `tiktest.md`, `tik-test.md`, or a `README.md` containing either a `## TikTest`/`## Testing` (or alias) heading or a bare `http://` / `https://` URL — the CLI extracts the URL from any of these. In this path no URL is resolved here — the CLI parses it from the file.
   - Else, stop and tell the user: "Couldn't find a dev server on ports 3000/5173/4173/8080, and no tiktest.md in the current directory. Either start a dev server, pass a URL as an argument (`/tiktest:run http://localhost:1234`), or add the URL to `tiktest.md` (either as a frontmatter `url:` line between `---` fences, or as a bare `http://…` / `https://…` URL anywhere in the body)."

3. **Set up the run directory and config.** First create a tmpdir for run output (always — used for `--out-dir` regardless of config source):

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

   Stream the output back to the user as it runs. The CLI prints four numbered phases (plan, run, checklist, edit) and lands on a `✓ done` line with the path to the produced MP4.

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

6. **Report back** with two parts: (a) the absolute path to the MP4 (e.g. `~/Desktop/tiktest-<timestamp>.mp4`) plus one line describing what the walkthrough shows, and (b) the checklist as printed by the CLI in stdout — copy the section ending with the `N checks · M passed · K failed · J skipped` summary line, including the labelled `✓` / `✗` / `·` rows above it, so the user (or their agent) can immediately see what passed, what failed, and start fixing failures.

## What NOT to do

- Do not invent a URL the user didn't give you and the probe didn't find.
- Do not retry the CLI on failure — surface the CLI's own error message verbatim and stop. The CLI's errors are already actionable.
- Do not delete `$TIKTEST_TMP` until after the MP4 has been moved successfully — the run logs are useful if the move fails.
```

- [ ] **Step 2.3: Lint for app-specific wording per CLAUDE.md hard rules**

```bash
grep -in -E "taskpad|todo|crm|inspiration|theater" plugin/skills/run/SKILL.md
```

Expected: no matches (per CLAUDE.md "prompts must be completely domain-agnostic").

- [ ] **Step 2.4: Commit**

```bash
git add plugin/skills/run/SKILL.md
git commit -m "feat(plugin): add /tiktest:run slash command"
```

---

## Task 3: `/tiktest:quick` skill

**Files:**
- Create: `plugin/skills/quick/SKILL.md`

Same shape as `run`, but with `--no-video` and prints the checklist into the chat instead of writing an MP4.

- [ ] **Step 3.1: Create the skill directory**

```bash
mkdir -p plugin/skills/quick
```

- [ ] **Step 3.2: Write the skill**

```markdown
---
description: Run tik-test in checks-only mode (no video render) and print the checklist. Use when the user wants a fast, cheap pass over the running app — no MP4 produced.
allowed-tools: Bash, Read, Write
---

# tiktest:quick

The user wants a fast, cheap pass over whatever's running locally — same agent run as `/tiktest:run` but without rendering a video; output is a chat-printed checklist.

## Argument

`$ARGUMENTS` — optional. If non-empty and looks like a URL (starts with `http://` or `https://`), use it as the target. Otherwise treat as freeform context for what to focus the run on.

## Steps

1. **Preflight check prerequisites.** Run all four checks in parallel and collect any failures before doing anything else. (`ffmpeg` isn't strictly needed in `--no-video` mode, but check it anyway for consistency with `/tiktest:run` — the same install gives you both.)

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
   - **(c)** Else, look for a `tiktest.md`, `tik-test.md`, or a `README.md` containing either a `## TikTest`/`## Testing` (or alias) heading or a bare `http://` / `https://` URL — the CLI extracts the URL from any of these. In this path no URL is resolved here — the CLI parses it from the file.
   - Else, stop and tell the user: "Couldn't find a dev server on ports 3000/5173/4173/8080, and no tiktest.md in the current directory. Either start a dev server, pass a URL as an argument (`/tiktest:quick http://localhost:1234`), or add the URL to `tiktest.md` (either as a frontmatter `url:` line between `---` fences, or as a bare `http://…` / `https://…` URL anywhere in the body)."

3. **Set up the run directory and config.** First create a tmpdir for run output (always — used for `--out-dir` regardless of config source):

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

     Auto-generated config from /tiktest:quick. Exercise the primary surface. <ARGUMENTS_IF_NOT_URL>
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

- Do not produce an MP4 — `--no-video` is the whole point of this command. If you find yourself moving an `.mp4` file anywhere, you've got the wrong skill; use `/tiktest:run`.
- Do not retry the CLI on failure — surface the CLI's own error message verbatim and stop. The CLI's errors are already actionable.
```

- [ ] **Step 3.3: Lint for app-specific wording**

```bash
grep -in -E "taskpad|todo|crm|inspiration|theater" plugin/skills/quick/SKILL.md
```

Expected: no matches.

- [ ] **Step 3.4: Commit**

```bash
git add plugin/skills/quick/SKILL.md
git commit -m "feat(plugin): add /tiktest:quick slash command"
```

---

## Task 4: `tiktest-runner` sub-agent

**Files:**
- Create: `plugin/agents/tiktest-runner.md`

The sub-agent is invocable via the Task tool from any Claude Code session. It bundles both the record and checks-only flows into one prompt and chooses the right one based on the dispatch instruction.

- [ ] **Step 4.1: Create the agents directory**

```bash
mkdir -p plugin/agents
```

- [ ] **Step 4.2: Write the agent**

```markdown
---
name: tiktest-runner
description: Records a TikTok-style video walkthrough or runs a checks-only pass against the user's running dev server using the tik-test CLI. Use when asked to "record a walkthrough", "make a tik-test video", "run a tik-test pass", or anything similar that maps to driving the tik-test CLI.
tools: Bash, Read, Write
---

# tiktest-runner

You are dispatched as a sub-agent to drive the `tik-test` CLI on behalf of the parent session. Your job is exactly one CLI invocation, surfaced cleanly back to the parent.

## Inputs you may receive in your dispatch prompt

- **An explicit target URL** (e.g. `http://localhost:5173` or `https://staging.example.com`) — use directly as the URL.
- **A focus description** (e.g. "the new settings page", "the primary action") — pass through as freeform context in the generated config so the CLI's plan agent can bias its exploration.
- **A mode hint** — phrases like "no video", "checks only", "checklist only" mean run with `--no-video` and skip the video-render path. Anything else (or no hint at all) means produce a video.

A single dispatch prompt may combine any of the above.

## Procedure

1. **Preflight prerequisites.** Run all four checks in parallel and collect any failures before doing anything else:

   ```bash
   command -v tik-test || echo "MISSING tik-test"
   command -v claude   || echo "MISSING claude"
   command -v ffmpeg   || echo "MISSING ffmpeg"
   # Chromium binary check — Playwright stores under ~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux:
   ls "$HOME/Library/Caches/ms-playwright"/chromium-*/ 2>/dev/null || ls "$HOME/.cache/ms-playwright"/chromium-*/ 2>/dev/null || echo "MISSING chromium"
   ```

   If any line printed `MISSING …`, stop and return a single actionable message to the parent:

   - `MISSING tik-test` → "Install the CLI: `npm install -g tik-test`"
   - `MISSING claude` → "Install Claude Code: <https://docs.claude.com/en/docs/claude-code/setup>"
   - `MISSING ffmpeg` → "Install ffmpeg: `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux)"
   - `MISSING chromium` → "Install the Playwright browser: `npx playwright install chromium`"

   Do not proceed if anything is missing.

2. **Resolve target URL.** Three resolution paths — remember which one you took, step 4 branches on it:
   - **(a)** If the dispatch prompt contains an explicit URL (starts with `http://` or `https://`), that is the URL.
   - **(b)** Else, probe each of these in order with `curl -sf -o /dev/null --max-time 1 <url>` and use the first that responds: `http://localhost:3000`, `http://localhost:5173`, `http://localhost:4173`, `http://localhost:8080`.
   - **(c)** Else, look for a `tiktest.md`, `tik-test.md`, or a `README.md` containing either a `## TikTest`/`## Testing` (or alias) heading or a bare `http://` / `https://` URL — the CLI extracts the URL from any of these. In this path no URL is resolved here — the CLI parses it from the file.
   - Else, stop and return to the parent: "Couldn't find a dev server on ports 3000/5173/4173/8080, and no tiktest.md in the current directory. Either start a dev server, dispatch with an explicit URL in the prompt, or add the URL to `tiktest.md` (either as a frontmatter `url:` line between `---` fences, or as a bare `http://…` / `https://…` URL anywhere in the body)."

3. **Set up the run directory and config.** First create a tmpdir for run output (always — used for `--out-dir` regardless of config source):

   ```bash
   TIKTEST_TMP=$(mktemp -d -t tiktest-XXXXXX)
   ```

   Then decide what `<CONFIG_PATH>` should be:

   - **If the cwd has `tiktest.md`, `tik-test.md`, or `README.md` with any of these tik-test headings: `## TikTest`, `## tik-test`, `## Testing`, `## How to Test`, `## Test Setup`, `## Test Environment`, `## Test Instructions`** (step 2 path c, OR a usable config existed alongside a resolved URL): set `<CONFIG_PATH>` to that file's absolute path.
   - **Otherwise** (paths a/b with no cwd config): use the **Write tool** (which is in `tools`, so the file content is written verbatim and shell metacharacters from the dispatch prompt aren't expanded) to create a config file at `${TIKTEST_TMP}/tiktest.md` with this content:

     ```
     ---
     url: <RESOLVED_URL>
     ---

     Auto-generated config from the tiktest-runner sub-agent. Explore the primary surface and exercise the main user-facing actions. <FOCUS_CONTEXT>
     ```

     Substitute `<RESOLVED_URL>` with the URL you resolved in step 2. Substitute `<FOCUS_CONTEXT>` with the literal focus description from your dispatch prompt if any was provided — otherwise drop that trailing sentence fragment entirely. Do not use a Bash heredoc; use the Write tool so the content lands as-is. Set `<CONFIG_PATH>` to `${TIKTEST_TMP}/tiktest.md`.

4. **Invoke the CLI.** **Decide mode now.** Checks-only mode if the dispatch prompt indicated *no video / checks only / checklist only / skip render / just the checks / a checklist*; video mode otherwise (this is the default).

   Use the `tik-test` binary on PATH (installed via `npm install -g tik-test`) — version-locked with the plugin you're running. Do **not** use `npx -y tik-test@latest` (that would fetch a different version than the plugin and defeat the reuse principle).

   - **If you resolved a URL in step 2 (paths a or b)**, pass it explicitly.

     **If checks-only mode was selected (per the decision above), append `--no-video` to the command.**

     ```bash
     tik-test run \
       --config "<CONFIG_PATH>" \
       --out-dir "$TIKTEST_TMP/runs" \
       --url "<RESOLVED_URL>"
     ```

   - **If you fell through to step 2 path c** (existing `tiktest.md` / `tik-test.md` / `README.md` in cwd), omit `--url` so the CLI extracts it from the config file.

     **If checks-only mode was selected (per the decision above), append `--no-video` to the command.**

     ```bash
     tik-test run \
       --config "<CONFIG_PATH>" \
       --out-dir "$TIKTEST_TMP/runs"
     ```

   Stream the output back to the parent as it runs. The CLI prints its planned phases and lands on a `✓ done` (or `✗`) summary line.

5. **Move the MP4 to a stable, user-visible location.** **Video mode only** — skip this entire step in checks-only mode (the CLI didn't produce an MP4, there's nothing to move).

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

6. **Return to parent.**
   - **Video mode:** the absolute MP4 path plus a single sentence describing what the walkthrough shows (a generic "Walkthrough recorded — open in any video player." is fine).
   - **Checks mode:** the checklist as the CLI printed it verbatim — the `✓` (passed), `✗` (failed), and `·` (skipped / not-attempted) lines are the whole point of this dispatch — plus the path to `events.json`, so the parent can dig into raw tool-use events if it wants more than the summary. The events.json lives at the path printed by:

     ```bash
     find "$TIKTEST_TMP/runs" -name "events.json" -print -quit
     ```

     Pass that path back to the parent.

## Constraints

- **One CLI invocation per dispatch.** Do not retry on failure — surface the CLI's own error message verbatim back to the parent and stop. The CLI's errors are already actionable.
- **Do not narrate the run.** The parent already sees the streaming CLI output; extra commentary is noise.
- **Do not produce extra files** beyond what the CLI emits and the one MP4 you move (video mode only). The parent expects a clean handoff: one path (video mode) or one checklist + one events.json path (checks mode).
```

- [ ] **Step 4.3: Lint for app-specific wording**

```bash
grep -in -E "taskpad|todo|crm|inspiration|theater" plugin/agents/tiktest-runner.md
```

Expected: no matches.

- [ ] **Step 4.4: Commit**

```bash
git add plugin/agents/tiktest-runner.md
git commit -m "feat(plugin): add tiktest-runner sub-agent"
```

---

## Task 5: Ship plugin in the npm tarball

**Files:**
- Modify: `package.json` (the `files` array, around line 17 in the current file)

Currently `files` is `["dist/", "remotion/", "action.yml", "README.md", "LICENSE"]`. We need to add `"plugin/"` so the plugin directory ships when users `npm install -g tik-test`. The plugin doesn't *strictly* need to ship in the npm tarball (users can install via `claude plugin install` from a marketplace), but shipping it lets the tarball be a drop-in plugin source for `claude --plugin-dir node_modules/tik-test/plugin` and keeps the source-of-truth single.

- [ ] **Step 5.1: Read the current package.json `files` block**

```bash
grep -n -A 7 '"files":' package.json
```

- [ ] **Step 5.2: Add `"plugin/"` to the `files` array**

Edit `package.json` so the array reads:

```json
  "files": [
    "dist/",
    "remotion/",
    "plugin/",
    "action.yml",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Step 5.3: Verify with a dry-run pack**

```bash
npm pack --dry-run 2>&1 | grep "plugin/"
```

Expected: at least four lines mentioning `plugin/.claude-plugin/plugin.json`, `plugin/skills/run/SKILL.md`, `plugin/skills/quick/SKILL.md`, `plugin/agents/tiktest-runner.md`.

- [ ] **Step 5.4: Commit**

```bash
git add package.json
git commit -m "build: ship plugin/ in the npm tarball"
```

---

## Task 6: Documentation

**Files:**
- Create: `docs/PLUGIN.md`
- Modify: `README.md` (add a small section linking to `docs/PLUGIN.md`)

- [ ] **Step 6.1: Write `docs/PLUGIN.md`**

```markdown
# Use tik-test from Claude Code

`tik-test` ships as a Claude Code plugin so you can record a video walkthrough of your local dev server without leaving Claude Code — no GitHub PR, no CI runner, no setup beyond `npm` + `claude`.

## Prerequisites

The plugin is markdown-only — all the heavy lifting happens in the `tik-test` CLI, which has the same prerequisites whether you call it from this plugin, the GitHub Action, or your shell:

| Prerequisite | Why | Install |
| --- | --- | --- |
| **Node.js ≥ 22** | Runs the CLI | <https://nodejs.org> |
| **`tik-test` on PATH** | The plugin shells out to it (one binary, version-locked with the plugin) | `npm install -g tik-test` (also installs `playwright`, `@playwright/mcp`, `@remotion/*` as transitive deps) |
| **`claude` on PATH** | The CLI spawns `claude` to drive the agent | <https://docs.claude.com/en/docs/claude-code/setup> |
| **`ffmpeg` on PATH** | Final mux step in the video pipeline | `brew install ffmpeg` (mac) / `sudo apt install ffmpeg` (Linux) |
| **Playwright Chromium** | The browser the agent drives | `npx playwright install chromium` |

The plugin's slash commands run all five checks before doing anything expensive and print a copy-pasteable install command for each missing piece.

## Install (local development)

Until the plugin is on the official marketplace, install from the npm tarball:

```bash
npm install -g tik-test                                    # gets CLI + plugin in one tarball
claude --plugin-dir "$(npm root -g)/tik-test/plugin"       # load the plugin
```

The CLI binary, the plugin, and every transitive runtime dep are now version-locked under one install — bumping the npm package updates everything in lockstep, including the GitHub Action's published artifact.

Or clone the repo and point `--plugin-dir` at the cloned `plugin/`:

```bash
git clone https://github.com/marcushyett/tik-test
cd tik-test && npm install && npm run build && npm link    # makes `tik-test` available on PATH from the local checkout
claude --plugin-dir ./plugin
```

To use the plugin across sessions without `--plugin-dir`, follow the [marketplace install instructions](https://code.claude.com/docs/en/discover-plugins) once the plugin is published.

## Slash commands

- `/tiktest:run [url]` — Records a ~60-second walkthrough and drops `~/Desktop/tiktest-<timestamp>.mp4` (`~/tiktest-<timestamp>.mp4` on Linux). Auto-detects a dev server on ports 3000, 5173, 4173, 8080. Pass a URL explicitly to override.
- `/tiktest:quick [url]` — Runs the same agent pass without rendering a video and prints a `✓` / `✗` checklist into the chat. Faster and cheaper than `:run`.

Both commands use the existing `tik-test` CLI under the hood, so the same OAuth token and Claude subscription budget apply (no separate API key).

## Sub-agent

`tiktest-runner` — invocable as a Task from any Claude Code session:

> "Use the tiktest-runner agent to record a walkthrough of the new settings page."

The agent infers mode (video vs checks-only) from the dispatch prompt.

## What it needs (in addition to the prerequisites table above)

- A dev server running locally on one of the probed ports, **or** a URL passed explicitly.
- (Optional) A `tiktest.md` in your project with login instructions, selectors, or focus hints. Without one, the plugin generates a minimal temporary config and lets the agent explore.
- `claude` CLI signed in (`claude setup-token` if you haven't already).

## How it relates to the rest of tik-test

The plugin is a thin markdown-only wrapper. **All test execution, agent driving, and video editing logic lives in `src/` and is shared with the GitHub Action.** Both consumers shell out to the same `tik-test` binary, so any change to the CLI propagates to the plugin automatically — no duplication, no skew, no separate test matrix.

## Troubleshooting

- **"Couldn't find a dev server on ports …"** — Start your dev server, or pass `/tiktest:run http://localhost:<your-port>`.
- **Plugin doesn't show up in `/help`** — Run `/reload-plugins`, or restart Claude Code with `--plugin-dir` pointed at the right path.
- **CLI errors during the run** — The plugin surfaces tik-test's own errors verbatim. Most are actionable (missing URL, dev server returned 5xx, etc).

## Publishing to the official marketplace

Once stable:
1. Bump `plugin/.claude-plugin/plugin.json`'s `version` field.
2. Submit at <https://claude.ai/settings/plugins/submit>.
3. After approval, users can `claude plugin install tiktest` directly.

The `version` field gates updates — bump it whenever you ship plugin-visible changes.
```

- [ ] **Step 6.2: Add a Claude Code plugin section to `README.md`**

The README has a `## Quickstart` section (around line 172 in the current README) with two numbered subsections (`### 1. Local app`, `### 2. GitHub PR`). Add a third subsection `### 3. Claude Code plugin` right after `### 2. GitHub PR` and before the `---` separator. This puts plugin install front-and-center for any user reading the Quickstart, with copy-pasteable commands inline rather than a bare link.

Insert exactly this block (preserve surrounding context — don't reflow the file):

```markdown
### 3. Claude Code plugin

Already inside a Claude Code session? Install the plugin and record a walkthrough of whatever's running locally — no PR or CI required.

```sh
npm install -g tik-test                                 # CLI + plugin in one tarball
npx playwright install chromium                         # browser the agent drives
claude --plugin-dir "$(npm root -g)/tik-test/plugin"    # load the plugin
```

Then in the Claude Code prompt:

```
/tiktest:run                  # auto-detects localhost dev server, drops MP4 on Desktop
/tiktest:run http://localhost:5173    # explicit URL
/tiktest:quick                # no video — faster, prints checklist in chat
```

Or invoke the bundled sub-agent from any session: *"Use the tiktest-runner agent to record a walkthrough of …"*.

Full install + troubleshooting guide: [docs/PLUGIN.md](docs/PLUGIN.md).
```

(The `### 3. Claude Code plugin` heading matches the existing numbering style; the inline `sh` blocks match the existing pattern; the closing link to `docs/PLUGIN.md` lets the deep-dive content live in one place.)

Also: the existing `## Prerequisites` section (around line 35) lists prerequisites for running the CLI directly. The plugin's prerequisites are the same set plus `claude` itself. Add one line near the bottom of `## Prerequisites`:

```markdown
- **Claude Code CLI** (only required if you want to use the [Claude Code plugin](#3-claude-code-plugin)): install from <https://docs.claude.com/en/docs/claude-code/setup>.
```

This way the README stays self-contained — a user discovers the plugin in the Quickstart, sees that `claude` is the one extra prerequisite, and has everything they need without leaving the README.

- [ ] **Step 6.3: Lint docs for app-specific wording**

```bash
grep -in -E "taskpad|todo|crm|inspiration|theater" docs/PLUGIN.md README.md
```

Expected: any hits in `README.md` that already exist (e.g. `examples/todo-app` references) are pre-existing and fine. New hits in `docs/PLUGIN.md` are bugs and must be removed.

- [ ] **Step 6.4: Commit**

```bash
git add docs/PLUGIN.md README.md
git commit -m "docs(plugin): add install + usage guide for the Claude Code plugin"
```

---

## Task 7: Manual verification

The plugin is mostly markdown — no unit tests. Verification is a real end-to-end run.

- [ ] **Step 7.1: Build the CLI fresh and link it onto PATH** (the plugin invokes the local `tik-test` binary, so we need the local checkout on PATH while testing — same install posture an end-user would have after `npm install -g tik-test`)

```bash
npm run build
npm link    # makes `tik-test` resolve to this checkout's dist/cli.js on PATH
which tik-test && tik-test --version
```

Expected: clean tsc build, `which tik-test` prints the global bin path, `tik-test --version` prints `0.1.0`.

- [ ] **Step 7.2: Start the bundled demo dev server in another terminal**

```bash
cd examples/todo-app && python3 -m http.server 4173
```

Expected: server listening on http://localhost:4173.

- [ ] **Step 7.3: Open Claude Code with the plugin loaded**

In a *different* shell, in a *different* directory (to simulate a real consumer):

```bash
mkdir /tmp/tiktest-plugin-smoke && cd /tmp/tiktest-plugin-smoke
claude --plugin-dir /Users/marcushyett/dev/tik-test-plugin/plugin
```

In the Claude Code prompt, run `/help` and verify both `/tiktest:run` and `/tiktest:quick` appear, and that `/agents` lists `tiktest-runner`.

- [ ] **Step 7.4: Smoke-test `/tiktest:quick`**

Inside the plugin-loaded Claude Code session:

```
/tiktest:quick http://localhost:4173
```

Expected: the agent runs, the CLI streams its three phases, a checklist prints. **No MP4** is produced.

- [ ] **Step 7.5: Smoke-test `/tiktest:run`**

```
/tiktest:run http://localhost:4173
```

Expected: same agent run, plus an MP4 lands at `~/Desktop/tiktest-<timestamp>.mp4` (or `~/tiktest-<timestamp>.mp4` on Linux). Open it in a video player and confirm it plays.

- [ ] **Step 7.6: Smoke-test the sub-agent**

```
Use the tiktest-runner agent to run a checks-only pass against http://localhost:4173.
```

Expected: a sub-agent dispatches, runs the CLI with `--no-video`, returns a checklist summary.

- [ ] **Step 7.7: Test the no-URL path**

In a directory with no `tiktest.md` and no dev server running:

```
/tiktest:run
```

Expected: the agent reports the explicit error "Couldn't find a dev server on ports 3000/5173/4173/8080…" — does not crash, does not silently hang.

- [ ] **Step 7.8: Test the preflight error path**

Temporarily mask one of the prereqs (e.g. `PATH=/usr/bin claude --plugin-dir …` to hide `tik-test` and `ffmpeg` from PATH), then invoke `/tiktest:run http://localhost:4173`.

Expected: the skill prints the install commands for the missing prereqs and stops *before* attempting to run the CLI. Restore PATH after.

- [ ] **Step 7.9: Document any deviations**

If any of 7.4–7.7 doesn't behave as expected, capture the discrepancy and either fix in-task or open a follow-up issue. Do **not** mark this plan complete with known smoke-test failures.

---

## Task 8: Open the PR

- [ ] **Step 8.1: Push the branch**

```bash
git push -u origin feat/claude-code-plugin
```

- [ ] **Step 8.2: Open the PR with the issue link**

```bash
gh pr create --title "feat: ship tik-test as a Claude Code plugin" --body "$(cat <<'EOF'
## Summary
- Adds `plugin/` with a Claude Code plugin manifest, two slash-command skills, and a sub-agent
- Adds `docs/PLUGIN.md` with install + usage instructions
- Adds `plugin/` to the npm `files` whitelist so it ships in the published tarball

Closes #15 (Phase 1).

Phase 2 (MCP server) and Phase 3 (`/tiktest:init` + `/tiktest:config`) remain open for follow-up.

## Test plan
- [x] `claude --plugin-dir ./plugin` loads the plugin; `/help` shows `/tiktest:run` and `/tiktest:quick`; `/agents` shows `tiktest-runner`
- [x] `/tiktest:quick http://localhost:4173` against the bundled demo prints a checklist, no MP4 produced
- [x] `/tiktest:run http://localhost:4173` produces `~/Desktop/tiktest-<timestamp>.mp4` and the file plays
- [x] Sub-agent invocation via Task produces equivalent output
- [x] No-URL fallback prints the explicit error message

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8.3: Post the PR URL back to the user**

---

## Task 9: `/tiktest:setup` skill

**Why:** the existing `run` / `quick` skills work without a `tiktest.md` (they synthesise a temp config from the resolved URL plus `$ARGUMENTS`), but the resulting agent run misses every project-specific signal — login flow, demo credentials, what surfaces matter, what selectors are stable. A persistent `tiktest.md` is the difference between a generic "click around" run and a focused walkthrough. Forcing the user to hand-write that file is the obvious onboarding cliff. `/tiktest:setup` removes the cliff: inspect the project, fill what's clearly there, ask about what isn't, write the file once.

**Files:**
- Create: `plugin/skills/setup/SKILL.md`
- Modify: `docs/PLUGIN.md` (add a third bullet to the "Slash commands" section)
- Modify: `README.md` (add `/tiktest:setup` as the first bullet in the `### 3. Claude Code plugin` slash-command code block)

- [ ] **Step 9.1: Create the skill directory**

```bash
mkdir -p plugin/skills/setup
```

- [ ] **Step 9.2: Write `plugin/skills/setup/SKILL.md`**

Use the Write tool. The body matches the existing `run` / `quick` SKILLs in style — frontmatter with `description` + `allowed-tools`, a short H1, a numbered Steps section, and a What-NOT-to-do section. Keep it concise (~80–120 lines). The full content is:

```markdown
---
description: Scaffold a tiktest.md config file in the current project by inferring dev-server URL, start command, and auth flow from README, package.json, and framework configs. Use when the user wants to set up tik-test for a new project, or when /tiktest:run / /tiktest:quick says "no tiktest.md found".
allowed-tools: Bash, Read, Write
---

# tiktest:setup

The user wants a real, persistent `tiktest.md` in their project so they can run `/tiktest:run` / `/tiktest:quick` without re-deriving the URL, start command, and login each time. Inspect the project, infer what you can, ask the user for what you can't, and write the file.

## Steps

1. **Bail if a config already exists.** Check the cwd for either filename:

   ```bash
   ls tiktest.md tik-test.md 2>/dev/null
   ```

   If either prints, stop and report: "Found existing config at `<path>`. Edit it directly, or delete it first if you want to regenerate." Do **not** overwrite.

2. **Inspect the project — opportunistically, not exhaustively.** Read whatever config and source files give the strongest signal about how the project runs locally and whether it has auth. Pick what's relevant per project; do not enumerate every possible file. The Read tool handles missing files gracefully — try the obvious candidates and stop once you have enough signal.

   Useful sources (sample, don't exhaust):
   - The package / build manifest (`package.json`, `pyproject.toml`, `Gemfile`, `Cargo.toml`, `go.mod`) for project name + description + dev-server scripts.
   - `README.md` — look for sections like "Local dev", "Getting started", "Development", "Install", "Login", "Demo credentials".
   - Framework configs that pin a dev port (`vite.config.*`, `next.config.*`, `astro.config.*`, `svelte.config.*`, `vue.config.*`, `nuxt.config.*`, `webpack.config.*`, `vercel.json`, `turbo.json`).
   - Server entry points for non-JS stacks (FastAPI / Flask / Django `app.py` or `manage.py`, Sinatra `config.ru`, Go `main.go` for `http.ListenAndServe`).
   - `Makefile` / `justfile` for `dev` / `start` / `run` targets.
   - `.env.example` for default ports and any committed dev credentials.
   - `docker-compose.yml` for service ports.

   If the answer's already in `package.json` and `README.md`, you're done — don't read the rest of the source tree.

3. **Synthesize a draft `tiktest.md`** from what you found. The shape is:

   ```markdown
   # <Project name>

   <One-paragraph description of what the project does and the primary surfaces.>

   ## Login

   <Auth instructions — only include this section if you found evidence of an auth flow.>

   ## Local dev

   start: <command that starts the dev server>

   The project serves at <URL>.
   ```

   Fill what you can confidently infer:
   - **Project title + description**: from the manifest's `name` + `description`, or the README's H1 + first paragraph.
   - **URL**: the framework's default dev port (e.g. a Vite default → `http://localhost:5173`, a Next.js default → `http://localhost:3000`) or an explicit port from a config file. Use `http://localhost:<port>`.
   - **Start command**: whichever script the manifest exposes (`npm run dev`, `pnpm dev`, `yarn dev`, `python3 -m http.server <port>`, `cargo run`, etc).
   - **Login**: only fill this section if there's clear evidence (committed demo credentials in `.env.example`, a "## Demo credentials" section in the README, a hard-coded test user in source). **Do NOT invent credentials.**

4. **Identify gaps and ask one question at a time.** Anywhere you didn't find clear evidence, ask the user. Wait for the answer before asking the next question. Common gaps:

   - **No URL detected** (no framework config, no port in any inspected file): "What URL does the dev server run at? (e.g., `http://localhost:3000`)"
   - **No start command detected**: "What command starts the dev server? (e.g., `npm run dev`)"
   - **Auth surface present but no test creds found**: "Does the project require login? If so, paste any demo or test credentials we should use, or say 'no creds — manual login required'."
   - **Anything else worth asking** the user might want the agent to focus on or steer clear of (a half-built surface, a flaky modal, etc).

   Ask each question separately. Do not bundle them. If the user gives you everything in one reply, that's fine — incorporate and move on.

5. **Show the user the draft before writing.** Render the markdown in chat (inside a fenced block) and ask:

   > "Here's the draft `tiktest.md` I'm about to write:
   >
   > ```markdown
   > <draft>
   > ```
   >
   > Want me to write it as-is, or tweak anything first?"

   If the user wants edits, incorporate the feedback and re-render. Loop until the user approves.

6. **Write and confirm.** Use the Write tool (not a Bash heredoc — same shell-injection rationale as the other skills) to write the approved markdown to `<cwd>/tiktest.md`. Then tell the user:

   > "Created `tiktest.md`. You can edit it directly any time, or run `/tiktest:run` or `/tiktest:quick` to start using it."

## What NOT to do

- **Do not invent credentials, URLs, or commands.** If inspection didn't find evidence, ask the user. Silently fabricating any of these will mislead every future run.
- **Do not read the entire source tree.** Sample a handful of likely-relevant files, then stop. Token budget is real.
- **Do not overwrite an existing `tiktest.md` / `tik-test.md`.** Bail per Step 1.
- **Do not write the file before showing the draft.** The user must see and approve the draft first.
```

- [ ] **Step 9.3: Lint the SKILL for app-specific wording**

```bash
grep -in -E "taskpad|todo|crm|inspiration|theater" plugin/skills/setup/SKILL.md
```

Expected: no output. The SKILL must stay domain-agnostic per the CLAUDE.md hard rule — examples inside it must be generic placeholders ("the project", "the dev server", `http://localhost:<port>`), never real product names.

- [ ] **Step 9.4: Update `docs/PLUGIN.md` "Slash commands" section**

Add a third bullet for `/tiktest:setup` ahead of the existing two, matching their style:

```markdown
- `/tiktest:setup` — Inspects your project (package manifest, README, framework configs) and scaffolds a `tiktest.md` with the dev-server URL, start command, and login flow filled in. Asks for anything it can't infer. Run this first when setting up tik-test for a new project.
```

- [ ] **Step 9.5: Update README.md `### 3. Claude Code plugin` code block**

The slash-command snippet in README.md gets `/tiktest:setup` as the first bullet (users run it before `:run` / `:quick`). Replace the existing block:

```
/tiktest:setup                # scaffolds tiktest.md by inspecting your project, asks for what it can't infer
/tiktest:run                  # auto-detects localhost dev server, drops MP4 on Desktop
/tiktest:run http://localhost:5173    # explicit URL
/tiktest:quick                # no video — faster, prints checklist in chat
```

- [ ] **Step 9.6: Commit**

```bash
git add plugin/skills/setup/SKILL.md docs/PLUGIN.md README.md docs/superpowers/plans/2026-04-28-claude-code-plugin.md
git commit -m "feat(plugin): add /tiktest:setup skill to scaffold tiktest.md"
```

---

## Task 10: CLI always prints the checklist + plugin surfaces it

**Why:** today the `tik-test run` CLI only generates and prints a pass/fail checklist when invoked with `--no-video`. In normal video mode the checklist is buried inside the rendered MP4's outro card — so a `/tiktest:run` user gets the video path but no chat-side summary of what passed and what failed. They have to open the MP4 and pause on the outro, then transcribe what they saw before they can act on a failure. The checklist is universally useful — both the GitHub Action and the plugin benefit equally from having it printed to stdout — so the fix lives in `src/`, not in the SKILL prompts.

The cost is one extra Claude `sonnet` call per run (~5–10s for the synthesis prompt), which is negligible compared to the 60–120s of video render that follows it. The video editor already calls `generateChecklist` internally; we lift that single call up into the CLI's common path and pass the result down to the editor so it doesn't pay twice.

**Files:**
- Modify: `src/cli.ts` (the `run` command)
- Modify: `src/single-video-editor.ts` (accept an optional pre-computed checklist)
- Modify: `plugin/skills/run/SKILL.md` (step 6 — relay the checklist to the user along with the MP4 path)

- [ ] **Step 10.1: Refactor `src/cli.ts` `run` command**

  New phase shape (4 phases when rendering a video, 3 when `--no-video`):

  1. **Phase 1** — `generatePlan` (unchanged).
  2. **Phase 2** — `runPlan` (unchanged).
  3. **Phase 3 (always)** — `generateChecklist` → write `checklist.json` → `printChecklist` to stdout. The Claude Code plugin and CI both read this output.
  4. **Phase 4 (only if not `--no-video`)** — `editSingleVideo`, passed the pre-computed checklist via the new `precomputedChecklist` option so the editor doesn't re-invoke Claude.

  In `--no-video` mode, exit after phase 3 with the existing "checks-only — no video produced" footer. In video mode, exit after phase 4 with the MP4 path AND the checklist path printed alongside `events.json`.

- [ ] **Step 10.2: Add `precomputedChecklist` to `SingleVideoEditOptions`**

  In `src/single-video-editor.ts`, extend the options interface with an optional `precomputedChecklist?: ChecklistItem[] | null`. When the caller provides it (including explicitly `null`, meaning "we tried, the LLM returned nothing — fall back to goal-level rows"), the editor uses it instead of calling `generateChecklist` itself. When the caller omits the field, the editor synthesises one as before — the `pr` mode path stays unchanged.

- [ ] **Step 10.3: Update `plugin/skills/run/SKILL.md` step 6**

  Change step 6 from "report back the MP4 path with one line" to "report back the MP4 path AND the checklist as printed by the CLI" — the checklist is now in stdout for every run, so the SKILL just relays the labelled `✓` / `✗` / `·` rows + the summary line back to the user.

  Also update step 4's "three numbered phases" line to say "four numbered phases" to match the new CLI output.

- [ ] **Step 10.4: Verify**

  ```bash
  npx tsc -p tsconfig.json --noEmit
  diff plugin/skills/run/SKILL.md <(sed -n '<start>,<end>p' docs/superpowers/plans/2026-04-28-claude-code-plugin.md)
  grep -in -E "taskpad|todo|crm|inspiration|theater" plugin/skills/run/SKILL.md
  ```

  Typecheck must pass. The plan doc's embedded SKILL block must be byte-for-byte identical to the live SKILL.md (otherwise the doc drifts). The grep must be empty.

  Smoke-test the CLI directly (no agent — we just want to confirm the refactor compiles and gets through config-load + the new phase numbering):

  ```bash
  cd /tmp && mkdir -p tiktest-cli-smoke && cd tiktest-cli-smoke
  timeout 15 tsx /path/to/src/cli.ts run \
    --config /path/to/examples/todo-app/tiktest.md \
    --url "http://localhost:4173" --no-video --out-dir runs
  ```

  Expected: it prints "1/3 generating test plan" (correct phase numbering for `--no-video` mode) and then gets stopped by the timeout while talking to Claude.

- [ ] **Step 10.5: Commit**

  ```bash
  git add src/cli.ts src/single-video-editor.ts plugin/skills/run/SKILL.md docs/superpowers/plans/2026-04-28-claude-code-plugin.md
  git commit -m "feat(cli): always print the checklist after a run, regardless of video mode"
  ```

  No `dist/` rebuild — the source is the committed change; the next `npm publish` (or the smoke tests in Task 7) will pick it up.

---

## Self-review checklist (run after writing the plan, before execution)

- [x] **Spec coverage** — every Phase 1 checkbox in issue #15's "Phase 1" section maps to a task above (manifest → Task 1; slash command + URL probe → Tasks 2 & 3; sub-agent → Task 4; `package.json` files → Task 5; `docs/PLUGIN.md` → Task 6; marketplace publish — explicitly documented as out-of-scope per the spec ("requires in-app submission form")).
- [x] **No placeholders** — every code block contains the actual content. The only intentional placeholders are `<RESOLVED_URL>` and `<CONFIG_PATH>` inside the SKILL.md prompt bodies — those are *for the model to fill in at runtime*, which is the whole point of a slash-command prompt.
- [x] **Type / name consistency** — plugin name `tiktest` is used uniformly; skill names `run` / `quick`; agent name `tiktest-runner`; environment variable `TIKTEST_TMP` is used in all three skill bodies.
- [x] **Domain-agnostic** — Tasks 2.3 / 3.3 / 4.3 / 6.3 each include an explicit `grep` for product-name leakage, per the CLAUDE.md hard rule.
- [x] **Branch hygiene** — Step 0b creates a fresh worktree off `origin/main`; the existing `feat/auto-advance-on-merge` branch (already merged upstream) is not touched.
