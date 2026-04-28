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

The plugin's slash commands run all four runtime checks before doing anything expensive (Node.js is implied by `tik-test`) and print a copy-pasteable install command for each missing piece.

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

- `/tiktest:setup` — Inspects your project (package manifest, README, framework configs) and scaffolds a `tiktest.md` with the dev-server URL, start command, and login flow filled in. Asks for anything it can't infer. Run this first when setting up tik-test for a new project.
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
