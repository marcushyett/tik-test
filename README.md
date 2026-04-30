
# tiktest [![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**automated tiktok-style video review of every pr.**

the more i shipped stuff with claude the more i realised; in the long term the most value i can add as a human is testing - finding the stuff other humans would struggle with...

...but testing is boring. so i tried to make it less boring - or at least take way less of my time.

<p align="left">
  <a href="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.mp4">
    <img src="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.gif" alt="tik-test demo: 9:16 narrated video review of a PR" width="320" />
  </a>
  <br />
  <a href="https://github.com/marcushyett/tik-test/releases/download/v0.1.0/demo.mp4"><strong>play with sound</strong></a> to hear narration and watch normal speed
</p>

---

## get it running in a few mins

two paths. both are paste-and-go — claude code does the wiring.

**1. claude code plugin** — record a walkthrough of whatever you just shipped, locally. type these slash commands yourself (claude can't invoke them from inside a prompt), one at a time:

```
/plugin marketplace add marcushyett/tik-test
/plugin install tiktest@tiktest
/reload-plugins
```

then paste this prompt so claude finishes the wiring:

````
The tik-test Claude Code plugin is now installed. Finish setting it up for this project:
1. Verify the plugin's runtime prereqs are present and fix what's missing for my OS:
   - `ffmpeg` on PATH (`brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Linux)
   - Playwright Chromium (`npx playwright install chromium`)
   - `tik-test` CLI globally (`npm i -g tik-test`)
2. If a `tiktest.md` already exists at repo root, summarise it and ask me whether to keep, expand, or replace it before doing anything destructive. Otherwise run `/tiktest:setup` and ask me for anything you can't infer (project name, dev-server start command, login/auth flow, key user paths to record).
3. Tell me how to invoke `/tiktest:run` (full video, MP4 to Desktop) and `/tiktest:quick` (checklist only, no video) when I ship a feature, including the optional URL / focus-hint argument forms.
````

**2. github action** — `cd` into your repo, open claude code, paste:

````
Set up tik-test (https://github.com/marcushyett/tik-test — 45s video reviews on every PR) on this repo. Goal: working tik-test.yml + drafted tiktest.md + secret instructions, then test on a real PR.
1. Pick a template (local-dev / vercel-preview / staging-with-services) from inspecting package.json, framework configs, and deploy setup; ask if ambiguous. Create .github/workflows/tik-test.yml from it, adapted (build cmd, dev port, working-directory).
2. Draft tiktest.md at repo root: read README + package.json + 5-10 representative source files to infer flows; detect login (ask me for creds if there's a wall); list 3-5 highest-risk user-facing surfaces. Format: one-paragraph app description → login → "Risky surfaces" bullets → optional "Hints" with test-IDs. Show me the draft and wait for confirmation before committing. Warn if CLAUDE.md / AGENTS.md sit alongside it (silent-fallback footgun).
3. List the secrets I need to add: CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, required) plus optionals you detect apply (OPENAI_API_KEY for narration; VERCEL_AUTOMATION_BYPASS_SECRET if Vercel Deployment Protection is on). One line each on where to get them. Mention that TIKTEST_OWNERS in repo Variables can restrict who triggers runs (default = any collaborator).
4. Open the PR. Heads-up: tik-test's plan generator looks at the diff and will skip cleanly with a "no testable change" comment when the only edits are workflow + tiktest.md (no impact on the UI). That's expected, not a failure — the action itself is wired up correctly.
5. After I merge it, propose a small visible UI change (one-screen nit from open issues or your own suggestion) to be the real first test PR. Wait for my okay, then ship on a separate branch.
````

---

## the problem (or, why this exists for me)

ai ships 20+ prs a day that mostly work. where it fails is taste: awkward flows, off-brand copy, the counter-intuitive ways real users click. catching that means dropping what you're doing, opening the pr, exercising it, then switching back. twenty context switches a day.

tik-test puts a 45-60s narrated video on every pr: happy path, edge cases, bugs called out on camera. i skim 20 in my inbox between meetings and only context-switch into the ones that look off.

> the bottleneck of building products is shifting from writing code to **testing it well**. tik-test is my bet on that — your workflow might look totally different and that's fine.

## prerequisites

| what | why |
|---|---|
| a web app with a public preview url | tik-test drives a real browser. vercel, netlify, render, ngrok-tunneled localhost — anything reachable. |
| a `tiktest.md` at repo root (or `## TikTest` in `README.md`) | tells the agent the url, login, and what's risky. see [telling tik-test how to test your app](#telling-tik-test-how-to-test-your-app) below. |
| a claude code max subscription, OR an anthropic api key | tik-test invokes the `claude` cli directly, so cost comes out of your subscription. oauth is what i use; api key works too. |
| ci permissions | `contents: write`, `pull-requests: write`, `id-token: write`. |

optional, but nice:

- `OPENAI_API_KEY` for voice narration (silent on linux without it).
- `VERCEL_AUTOMATION_BYPASS_SECRET` for protected previews.
- claude code cli (only if you want the [claude code plugin](#3-claude-code-plugin)): install from <https://docs.claude.com/en/docs/claude-code/setup>.

---

## telling tik-test how to test your app

two pieces of context, in two places.

**1. project-level: `tiktest.md` at your repo root.** stable across prs. describes the app and how to sign in. free-form prose, no schema.

```markdown
# acme

acme is a project tracker for engineering teams.

login: email `review-bot@acme.app`, password `hunter2`. click the
"sign in with email" button on the landing page; the app then
redirects back to its home view.
```

a note on phrasing — describe navigation in terms a user would think about ("click sign in on the landing page", "open the side menu and choose settings") rather than absolute url paths. writing instructions like _"navigate to `/sign-in`"_ can lead an agent to assemble the wrong absolute url when the preview host doesn't resolve as expected. click-paths through visible ui are robust across previews, custom domains, and unusual routing setups. (i learnt this one the hard way.)

**optional: declare the expected sign-in button text.** if your app's landing page has multiple sign-in options (e.g. google + email + sso), add a `signin-button:` directive in yaml frontmatter so the agent's diagnostic on a failed login mentions the specific button it was looking for, listing the visible buttons it actually found instead.

```markdown
---
signin-button: Preview Sign In
---

# acme
…
```

**2. pr-level: a "what to test" note in your pr description.** changes per pr. tells the agent which surfaces this change touches and what's risky. skip it and tik-test plans from the diff alone (best-effort).

```markdown
## what to test
- bulk archive on the tasks list. select 5+ items, archive, confirm count.
- empty state when all tasks are archived.
```

### where the url comes from

two ways tik-test learns where to point the browser. pick whichever fits your setup:

- **per-pr preview urls** (vercel / netlify / similar). auto-detected from the `deployment_status` event in ci. don't put a url in `tiktest.md`; the action handles it. this is the common case.
- **stable test-environment url** (e.g. `dev.acme.app` always points at trunk). add it to `tiktest.md`: any `https://...` link in the file works.

if both are present the auto-detected preview url wins.

---

## how it's designed (and what it won't suit)

i built tik-test for **small, focused prs that touch one user-facing slice at a time**. this is what alistair cockburn calls [elephant carpaccio](https://alistaircockburn.com/Elephant-Carpaccio): nano-slices that each ship value end-to-end. if you bundle ten features into a 2,000-line pr, break it up, or the video will skim two and miss the rest.

### works well

- **prs touching one user-facing slice.** forms, dialogs, lists, navigation, a single end-to-end flow. the agent picks 1-3 goals and probes them deeply.
- **flows the agent can drive via playwright mcp.** clicks, typing, hovers, keyboard shortcuts, dropdowns, file uploads. slow flows with login spinners are fine; the editor crops idle waits to 0.3s.
- **multi-page wizards** with seconds of actual interaction. page transitions aren't the problem; total interaction count is.
- **public-ish preview urls.** vercel-protected works via the bypass secret.
- **visible failures.** broken layout, validation that contradicts the input, button that doesn't fire, badge with the wrong colour.

### won't suit

- **giant prs adding 10+ features at once.** the plan picks 1-3 goals; the rest go uncovered.
- **design studios, canvas tools, drag-precise interactions.** figma-style apps, video editors. playwright can drive a `<canvas>` but the agent can't tell whether it dragged the handle to the right spot.
- **apps gated behind saml, sso, mfa, or per-tenant subdomains** with no automation bypass.
- **subtle regressions with no visible surface.** wrong analytics event, wrong db write, p95 perf regression, safari-14-only css bug.

defaults reflect how i review prs: small slices, fast feedback, video-first. yours might be different — `node dist/cli.js config` shows every knob and how to retune.

### fast mode vs meticulous mode

two ways the agent can drive the browser. default is **fast**; `--meticulous` (cli) or `meticulous: true` (action) flips it to thorough.

| | fast (default) | meticulous |
|---|---|---|
| per-goal turn cap | **25** | **100** |
| goal | shortest possible recording that still proves the feature works | exhaustive automated check; recording length secondary |
| loops | forbidden — one approach, one retry, then `OUTCOME: skipped` | stuck-loop guard still applies, but more headroom for legitimate retries |
| independent probes | bundled into one assistant turn (parallel `tool_use` blocks) | same — but the budget allows more sequential probing if needed |
| sub-second ui (loading indicators, toasts) | one freeze-the-moment attempt; if it doesn't catch the state, skip | full freeze recipe shelf available, multiple attempts if warranted |
| `browser_evaluate` cap | 4 | 8 |
| `browser_take_screenshot` cap | 3 | uncapped |
| typing | `slowly: true` (one character at a time, like a human) | same |
| click before type | required | required |

**fast mode** is the right default for me because the whole point of tik-test is producing a tight, watchable pr-review video. every wasted turn is a longer video. the agent prioritises the most important check first, retries once if it fails, and emits `OUTCOME: skipped — needs human verification: <reason>` instead of looping. **skipped goals do not mark the pr check red** — they're flagged for the human reviewer to look at. a clear "i couldn't auto-test this, please verify" beats 60s of a stuck agent every time.

**meticulous mode** is for high-stakes prs where you'd accept a longer video in exchange for a more careful auto-review — e.g. a payment flow, an auth rework, a migration that touches many surfaces. turn cap goes to 100; the agent gets the full freeze-the-moment recipe shelf and is willing to chase sub-second transitions through multiple recipes.

flip on per-pr with `--meticulous` (cli) or set `meticulous: true` on the github action input.

---

## in the wild

the demo above is the bundled taskpad app. agent caught two planted bugs (case-sensitive search, priority-sort reversed) and posted a request-changes review.

self-test: every pr to this repo gets reviewed by tik-test against the bundled [taskpad demo](examples/todo-app/) — see the most recent pr for an example video.

## watch in a feed

[**tiktest.dev**](https://tiktest.dev) is a tiktok-style web viewer for your tik-test videos. pure pass-through: github is the backend, i store nothing, no auth required beyond your existing github login. self-host instead with `node dist/cli.js view` against your local runs directory.

---

## how it works

```
                    ┌──────────────┐
                    │  tiktest.md  │◄── pr body, config, optional inline goal list
                    └──────┬───────┘
                           ▼
     ┌─────────────────────────────────────────────┐
     │ 1. plan           1-3 high-level goals      │  ← claude generates
     │ 2. drive          agent runs playwright mcp │  ← records raw.webm + tool log
     │ 3. narrate        claude writes the script  │  ← intro + beats + outro, one call
     │ 4. voice          openai tts (rotating)     │  ← one wav per beat
     │ 5. trim           ffmpeg crops idle waits   │  ← login spinners → 0.3s
     │ 6. compose        remotion overlays         │  ← pan/zoom, captions, clicks, audio
     │ 7. checklist      claude summarises 6-10    │  ← ai-checks list shown on outro
     │ 8. publish        github release + comment  │  ← + formal pr review (approve/reject)
     └─────────────────────────────────────────────┘
                           ▼
                  `highlights.mp4` + `preview.gif`
```

design notes:

- **one continuous master video**, not per-step clips. every overlay references the same timeline so desync is structurally impossible.
- **voice paces the video.** each beat sized to its narration; playbackRate clamped 1.0–1.6x.
- **remotion is compositor-only.** css transforms over the pre-trimmed master; ~20 fps render on apple silicon in `--quick` mode.
- **`claude` cli invoked directly** (not the sdk), so compute bills against your claude code max subscription.

---

## install

```sh
# macos
brew install ffmpeg node
gh auth login
git clone https://github.com/marcushyett/tik-test
cd tik-test
npm install
npx playwright install chromium
npm run build
```

```sh
# ubuntu / github action runner
sudo apt-get install -y ffmpeg fonts-dejavu
npm install
npx playwright install chromium --with-deps
npm run build
```

---

## quickstart

### 1. local app

```sh
python3 -m http.server 4173 --directory examples/todo-app &
node dist/cli.js run --config examples/todo-app/tiktest.md --quick
```

### 2. github pr

```sh
export OPENAI_API_KEY=...                            # voice (optional)
export VERCEL_AUTOMATION_BYPASS_SECRET=...           # protected previews (optional)

node dist/cli.js pr https://github.com/owner/repo/pull/42
```

useful flags:

| flag | what |
|---|---|
| `--quick` | 540×960 draft render, ~2 min |
| `--skip-clone` | run against current working directory |
| `--skip-comment` | render but don't post |
| `--require-pass` | exit non-zero if any goal failed |
| `--review <mode>` | `none` · `approve-on-pass` · `request-changes-on-fail` (default) · `always` |
| `--vercel-bypass <secret>` | bypass header + cookie |
| `--no-voice` | silent video |
| `--no-video` | skip render — text-only checklist comment instead (much faster) |
| `--strict-config` | refuse silent fallback to `CLAUDE.md` / bare `README.md`; require an explicit `tiktest.md` |
| `--meticulous` | thorough mode: 100 turns/goal, full verification hierarchy. default off — see [fast vs meticulous](#fast-mode-vs-meticulous-mode). |

### 3. claude code plugin

already inside a claude code session? four-step setup, two of which are one-time-per-machine.

**step 1 — install runtime prereqs (one-time per machine):**

```sh
npm install -g tik-test                          # cli binary the plugin shells out to
npx playwright install chromium                  # browser the agent drives
```

you also need `ffmpeg` on PATH (`brew install ffmpeg` on macos, `sudo apt install ffmpeg` on linux) and a `claude` cli signed in (`claude setup-token`).

**step 2 — add the marketplace and install the plugin (one-time per machine):**

in your claude code prompt:

```
/plugin marketplace add marcushyett/tik-test
/plugin install tiktest@tiktest
```

the slash commands are now available across all your future claude code sessions.

**step 3 — scaffold a `tiktest.md` for your project (one-time per project):**

`cd` into your project, then:

```
/tiktest:setup
```

this inspects your `package.json` / `README.md` / framework configs to draft a `tiktest.md`, then asks you for anything it can't infer (login credentials, special urls, areas to focus on).

**step 4 — record or test (whenever you ship a feature):**

```
/tiktest:run                          # agent test pass + mp4 walkthrough on Desktop + pass/fail checklist
/tiktest:run http://localhost:5173    # explicit url (skip the dev-server probe)
/tiktest:quick                        # no video — faster, prints checklist in chat
```

or invoke the bundled sub-agent from any session: *"use the tiktest-runner agent to record a walkthrough of the feature i just shipped."*

the agent reads `git diff origin/main..HEAD`, summarises what you changed, lists the things it'll exercise, then runs. soft confirmation — interrupt with words if you want a different focus.

**updating the plugin** later: `/plugin marketplace update tiktest`.

**hacking on the plugin itself?** clone the repo and use `claude --plugin-dir ./plugin` — see [docs/PLUGIN.md](docs/PLUGIN.md) for the development install + troubleshooting guide.

---

## inline test plan (optional)

by default the agent generates a plan from the pr diff plus your `## TikTest` section (or `tiktest.md`). for deterministic coverage, add a `### Test Plan` sub-section with a json goals list:

```json
{
  "name": "Theater mode",
  "summary": "Verify the new full-screen viewer keeps keyboard shortcuts working.",
  "startUrl": "https://acme-pr-42.vercel.app",
  "goals": [
    { "id": "open-theater", "intent": "Open the Inspiration grid and click Theater on any card.", "shortLabel": "Open Theater" },
    { "id": "kbd-shortcuts", "intent": "While in Theater mode, press Down, S, then Esc, verifying each works.", "shortLabel": "Keyboard nav", "importance": "high" }
  ]
}
```

**goal fields:** `intent` (required) · `shortLabel` (3-5 word checklist headline) · `success` (observable success condition) · `importance` (`low` · `normal` · `high` · `critical`).

**discovery order** when running `tik-test pr`: `tiktest.md` (preferred) → `README.md` with a `## TikTest` heading → legacy fallbacks (`claude.md` → `CLAUDE.md` → `.claude/claude.md` → bare `README.md`). pass `--strict-config` (or set `strict-config: true` on the action) to refuse the legacy fallbacks and fail fast if `tiktest.md` is missing.

---

## github action

> **quick start:** copy one of the three drop-in templates from
> [`templates/workflows/`](./templates/workflows/) into your repo at
> `.github/workflows/tik-test.yml`. the three options, picked by what
> your app needs to boot:
>
> - [`local-dev.yml`](./templates/workflows/local-dev.yml) — `npm run dev`
>   inside the runner. best for spas, static sites, next.js with mocked
>   apis.
> - [`vercel-preview.yml`](./templates/workflows/vercel-preview.yml) —
>   drive your per-pr vercel preview deployment. includes the
>   automation-bypass plumbing.
> - [`staging-with-services.yml`](./templates/workflows/staging-with-services.yml)
>   — boots postgres + redis service containers, runs migrations + seeds,
>   then starts the app. best for rails / django / next.js + prisma.
>
> see [`templates/workflows/README.md`](./templates/workflows/README.md)
> for the chooser tree and the per-template `tiktest.md` shape each one
> expects.
>
> the minimal hand-written yaml below is just here for reference if
> you'd rather wire the action up by hand than copy a template.

```yaml
# .github/workflows/tik-test.yml (rename to whatever you want — pick a path
# that matches your repo layout)
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
  contents: write
  pull-requests: write
  id-token: write

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
          pr-number:               ${{ github.event.inputs.pr_number }}     # workflow_dispatch only
```

the action installs node + ffmpeg + playwright, builds tik-test, auto-detects the pr number and preview url, runs the review, posts back.

### inputs

| input | required | default | what |
|---|---|---|---|
| `claude-code-oauth-token` | yes¹ | n/a | from `claude setup-token`. bills your claude code max subscription. |
| `anthropic-api-key` | yes¹ | n/a | pay-per-use alternative. |
| `openai-api-key` | no | n/a | enables openai tts. silent on linux without it. |
| `vercel-bypass-secret` | no | n/a | vercel automation bypass. |
| `pr-number` | no | auto | from `pull_request` / `deployment_status` / `workflow_dispatch`. |
| `preview-url` | no | auto | from `deployment_status.target_url` or `tiktest.md`. |
| `review-mode` | no | `request-changes-on-fail` | `none` · `approve-on-pass` · `request-changes-on-fail` · `always` |
| `require-pass` | no | `true` | non-zero exit on any failed goal. |
| `quick` | no | `true` | draft 540×960 render. |
| `quick-and-dirty` | no | `false` | drops to 0.5× render (540×960) **and** caps body scenes at 6. faster, lower-quality output — use when speed beats fidelity. |
| `meticulous` | no | `false` | thorough-testing mode. raises the per-goal turn cap from **25 → 100** and swaps the agent prompt for the exhaustive variant (full verification hierarchy + freeze-the-moment recipes). default off — the fast prompt optimises for the SHORTEST possible recording and bails to "needs human verification" instead of looping. flip on for high-stakes prs where a careful auto-review matters more than a snappy video. see [fast vs meticulous](#fast-mode-vs-meticulous-mode). |
| `no-video` | no | `false` | skip render + upload entirely. same plan + agent + checklist; posts a text-only checks-only pr comment instead of an mp4. **~5× faster** — pairs well with `run-on-every-push: true`. the checks-only comment deliberately omits the `tik-test-video:v1` marker so the reviewer web app does not pick it up as a feed entry. |
| `run-on-every-push` | no | `false` | re-review on every commit pushed to a pr (the `synchronize` event). off by default to keep claude usage under control. |
| `strict-config` | no | `false` | refuse silent fallback to `CLAUDE.md` / bare `README.md`; require an explicit `tiktest.md`. recommended for prod setups so a missing config fails fast instead of silently planning against the wrong file. |
| `working-directory` | no | repo root | subdirectory containing `tiktest.md`. useful for monorepos. |
| `plan-timeout` | no | `240` (s) | plan-generation claude call. bump for huge diffs. |
| `agent-timeout` | no | `600` (s) | per-goal agent. bump for slow page loads. |
| `narration-timeout` | no | `540` (s) | narration claude call. bump for 12+ tool moments. |

> plus more typed inputs for fine-tuning (`feature-finder-timeout`, `max-goals`, `min-chunk-seconds`, `trim-merge-seconds`, `max-body-scenes`, `checklist-min-items`, `checklist-max-items`, `intro-seconds`, `outro-seconds`, `outro-hold-seconds`, `render-segments`, `render-concurrency`, `video-cache-mb`, `node-max-old-space-mb`). see [advanced](#advanced) or `node dist/cli.js config`.

¹ one of the two. oauth recommended.

### secrets

| secret | required? | use |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | `claude setup-token` locally, paste into Settings → Secrets |
| `OPENAI_API_KEY` | optional | voice-over narration |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | optional | vercel deployment protection |
| `ANTHROPIC_API_KEY` | optional | pay-per-use alternative to oauth |

for the full end-to-end walkthrough — every token, where to create it, and where to paste it (including the optional reviewer web app + self-review ci) — see [`docs/SETUP.md`](./docs/SETUP.md).

### gating

- `review-mode: request-changes-on-fail` (default) blocks merge on repos requiring approval.
- `require-pass: true` (default) turns the check red on failure.
- set `require-pass: false` to keep the check green and rely only on the formal review.

### self-hosted reference

this repo dogfoods the action with two path-scoped workflows: [`tik-test-taskpad.yml`](.github/workflows/tik-test-taskpad.yml) (runs on prs touching `examples/todo-app/**`) and [`tik-test-webapp.yml`](.github/workflows/tik-test-webapp.yml) (runs on prs touching `web/**`). both use `uses: ./` instead of `marcushyett/tik-test@v1`.

---

## troubleshooting

**"plan generation timed out after 240000ms"**
pr diff is huge or `tiktest.md` is missing. bump `plan-timeout: 480` or trim the diff.

**"per-goal agent timed out after 600000ms"**
agent stuck. page didn't load, login is broken, or the goal is too vague. check the last `mcp__playwright_*` tool call. if your app is just slow, bump `agent-timeout: 1200`.

**"narration generation timed out after 540000ms"**
recording too long (15+ tool calls). trim goals, bump `narration-timeout: 900`, or set `TIK_MAX_BODY_SCENES=8`.

**silent video on the github runner**
set `OPENAI_API_KEY`. without it, linux runners ship silent.

**agent clicks the wrong button**
add a `## Hints` section to your `tiktest.md` describing the surface, or add `data-testid` attributes. the plan generator sees the diff but not the rendered dom.

**`claude: command not found` in ci**
use the github action; it bundles the install. outside ci, run `npm i -g @anthropic-ai/claude-code`.

**pr comment shows the marker but the video is broken**
expected fallback: if any post-process step crashes, tik-test still uploads the raw recording. check run artifacts.

**`Error: Process completed with exit code 143` (kernel oom kill)**
long captures + multiple parallel chromium browsers can exhaust the standard private-repo runner's 7 gb envelope. the action ships safe defaults — `render-segments: 1`, `video-cache-mb: 256`, `node-max-old-space-mb: 4096` — that should keep the job inside it. if you still see exit 143:

- lower further: `video-cache-mb: 128` (smallest practical), `quick-and-dirty: true`.
- or upgrade the runner: `runs-on: ubuntu-latest-8-cores` (paid github larger runner, ~32 gb / 8 vcpu). on a larger runner you can also speed the render up by raising `render-segments: 3` and `video-cache-mb: 512`.
- a heap-oom error from node (instead of a silent SIGTERM) means it's v8's heap, not the kernel — bump `node-max-old-space-mb: 6144`.

---

## advanced

> run `node dist/cli.js config` to print every knob with its current value, default, override hint, and risks. same data as below, scoped to your environment.

<details>
<summary><strong>every env-var knob: defaults, rationale, and risks of changing them</strong></summary>

defaults are tuned for a typical pr (1-3 goals, 30-60s recording, 8-12 narration scenes, 6-10 checklist items) on a claude max subscription. bump only after you've seen the corresponding default fail in your run.

every knob has a matching typed input on the github action (kebab-case version of the env-var, dropping the `TIK_` prefix and `_MS` suffix). prefer the typed input in yaml.

### voice / tts

| var | default | rationale | risk if changed |
|---|---|---|---|
| `OPENAI_API_KEY` | _(unset)_ | openai tts produces a natural voice on linux runners (where `say` doesn't exist). | silent video in ci without it. |
| `TIK_TTS_VOICE` | _(unset → rotates `ash` / `ballad` / `coral` / `verse` / `onyx` / `sage` per video, hashed off the runId)_ | binge-watching the feed would feel like one narrator if every video used the same voice. setting a value pins all videos to that voice. | one of the rotation voices may misread code identifiers; pin via `TIK_TTS_VOICE=ash` (or whichever you prefer) if you find a clear winner. |
| `TIK_TTS_MODEL` | `gpt-4o-mini-tts` | cheap and fast. higher tier doesn't measurably improve clip quality. | higher tier = slower + costlier; lower = mispronunciation. |

### auth & config strictness

| var | default | rationale | risk if changed |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | _(unset)_ | paid fallback when an oauth token isn't present. | bypasses claude code max; billing shifts to per-token. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | _(unset)_ | header + cookie so vercel-protected previews are reachable from ci. | without it, protected previews 404 the agent. |
| `TIK_STRICT_CONFIG=1` | _(off)_ | refuse silent fallback to `CLAUDE.md` / bare `README.md`; require an explicit `tiktest.md`. matches the `--strict-config` cli flag and the `strict-config: true` action input. | with it on, a missing/misnamed config fails fast (good for prod). off, the legacy fallbacks kick in silently. |

### debugging

| var | default | rationale | risk if changed |
|---|---|---|---|
| `TIK_KEEP_PUBLIC=1` | _(off)_ | keeps per-run `public/` directory (master mp4, voice wavs, raw recordings). | disk fills if you forget to clean up. |
| `TIK_KEEP_CLONE=1` | _(off)_ | keeps the temp directory tik-test clones prs into. | same disk caveat. |
| `TIK_KEEP_ARTIFACTS=1` | _(off)_ | keeps intermediate per-pr artifacts (events.json, raw video) instead of pruning at the end. | same disk caveat. |
| `TIK_KEEP_PARTS=1` | _(off)_ | keeps remotion's per-segment renders after stitching. handy when debugging a render glitch in one specific segment. | same disk caveat. |
| `TIK_FFMPEG_DEBUG=1` | _(off)_ | prints every ffmpeg invocation. | verbose. |
| `TIK_FFMPEG_PROGRESS=0` | _(progress on by default)_ | suppress the live ffmpeg progress bar. | quieter logs; you lose the encode-progress signal. |
| `TIK_REMOTION_DEBUG=1` | _(off)_ | verbose remotion renderer logs. | verbose. |
| `TIK_REMOTION_GL` | _(unset → remotion auto-picks)_ | force a webgl backend (`angle` / `swiftshader` / `vulkan` / `swangle`). useful on linux runners with broken gpu drivers. | wrong backend = render failures; unset means remotion picks one that works. |
| `TIK_RUNS_DIR` | `./runs` | where the local viewer (`view` subcommand) reads from. | point at a different folder if you want to host an archive. |

### claude cli timeouts (millisecond)

the action exposes all four as typed seconds inputs (`plan-timeout`, `agent-timeout`, `narration-timeout`, `feature-finder-timeout`). prefer those in yaml.

| var | default | rationale | risk: lower | risk: higher |
|---|---|---|---|---|
| `TIK_PLAN_TIMEOUT_MS` | `240000` (4 min) | plan call digesting pr diff + `tiktest.md`. 4 min handles a 500-line diff. | small diffs may still take 60s+. too low and you time out before the plan is drafted. | wastes ci budget on hung claude processes. |
| `TIK_AGENT_TIMEOUT_MS` | `600000` (10 min) | EACH per-goal browser-driving call. 10 min covers 12-tool-call goals with slow login. | a real cold start (vercel preview waking up) can eat 90s alone. | hung agents drain the 25-min job budget. |
| `TIK_NARRATION_TIMEOUT_MS` | `540000` (9 min) | one narration call covering intro + outro + every scene line. sonnet handles ~12 scenes in 5-8 min. | long runs (15+ scenes) regularly hit 6+ min. too low forces silent fallback. | trim scenes via `TIK_MAX_BODY_SCENES` instead; raising this doesn't unstick a wedged claude. |
| `TIK_FEATURE_FINDER_TIMEOUT_MS` | `60000` (1 min) | fallback when `startUrl` lands on a 404; claude tries to find a working url. | fallback may give up on apps with slow routing. | almost never doing useful work past 60s. |

### plan generation

| var | default | rationale | risk: lower | risk: higher |
|---|---|---|---|---|
| `TIK_MAX_GOALS` | `3` | hard ceiling on goals the planner produces. matches `max-goals` action input. | <2 leaves no room for an edge-case secondary goal. | >5 inflates video length past the ~60s scroll-feed sweet spot and may push the agent over the 25-min job budget. |

### body-narration density

| var | default | rationale | risk: lower | risk: higher |
|---|---|---|---|---|
| `TIK_MIN_CHUNK_S` | `3.5` (s) | shorter consecutive moments coalesce into the previous chunk. 3.5s gives claude breathing room per scene line. | <2s = many tiny scenes, narration prompt blows up, sonnet timeouts. | >6s = scenes feel sluggish, captions repeat themselves on screen. |
| `TIK_TRIM_MERGE_S` | `1.5` (s) | tolerance for collapsing adjacent active windows in the trim planner. tools that fire within this many seconds (`browser_click` → `browser_snapshot`, etc.) merge into one segment, dropping the cuts between them. big lever on render time — the master ffmpeg pass scales with segment count. | <0.5s = same dozens-of-segments problem the default fixes; ffmpeg encode goes from minutes to tens of minutes. | >3s = legitimately distinct beats fuse (click → wait → click reads as one beat); narration loses pacing. |
| `TIK_MAX_BODY_SCENES` | `12` | hard ceiling after coalescing. above this we sample evenly. | <8 misses interesting moments — agent clicks then jump-cut. | >14 risks narration call timing out; bump `TIK_NARRATION_TIMEOUT_MS` too. |

### outro checklist sizing

| var | default | rationale | risk: lower | risk: higher |
|---|---|---|---|---|
| `TIK_CHECKLIST_MIN_ITEMS` | `4` | minimum items the llm must produce — below this we treat the call as failed (fall back to one row per goal). | <3 = checklist always looks empty even on small prs. | >6 = llm frequently 'fails' on tiny prs that legitimately have only 3 things to check. |
| `TIK_CHECKLIST_MAX_ITEMS` | `10` | maximum items rendered. dense layout shrinks rows past 7. empirically the largest count that stays scannable in 9:16. | <6 hides legitimately interesting checks. | >12 overflows the safe band — items get clipped on mobile. |

### render memory / parallelism

defaults are tuned for the standard 7 gb private-repo github-hosted runner so the job doesn't get oom-killed (exit 143). bump them on bigger runners.

| var | default | rationale | risk: lower | risk: higher |
|---|---|---|---|---|
| `TIK_RENDER_SEGMENTS` | `1` | parallel chromium browsers used by remotion to render the video. each segment opens a separate browser and decodes the master capture in full, so memory grows roughly linearly with this number. | 1 = sequential render; safe everywhere but slower than parallel on big runners. | >1 multiplies resident ram by N — exit 143 (oom kill) on the standard 7 gb runner. |
| `TIK_RENDER_CONCURRENCY` | `8` (the action exposes `render-concurrency: ''` to mean auto-pick by cpu count) | concurrent chromium tabs PER segment. lower if you see oom kills on long captures. | <4 noticeably slows long renders. | >12 thrashes cpu without payoff on standard runners. |
| `TIK_OFFTHREAD_VIDEO_CACHE_MB` | `256` | per-segment offthread video cache. larger = faster reads from the master capture but more resident ram. | <128 = repeated re-decodes, render slows ~20-40%. | >512 on a 7 gb runner with multiple segments → exit 143 (oom). |
| `TIK_RENDER_SCALE` | _(unset → 1.0; `quick-and-dirty: true` forces 0.5)_ | render scale multiplier (fraction of native resolution). useful for hand-tuning render speed without flipping `--quick`. | <0.4 = visibly grainy frames; small text in agent screenshots stops being readable. | >1.0 = render takes much longer with no upload-side benefit (the gif/mp4 is downscaled anyway). |
| `NODE_MAX_OLD_SPACE_MB` | `4096` (set by the action; node default otherwise) | node.js heap cap (mb) for the tik-test process. surfaces a clean js heap-oom error instead of a silent SIGTERM from the kernel oom killer. set to 0 to leave node's default in place. matches `node-max-old-space-mb` action input. | <2048 risks heap oom on long captures with lots of events. | >runner ram = pointless; the kernel oom kill happens first. |

### intro / outro durations

| var | default | rationale | risk: lower | risk: higher |
|---|---|---|---|---|
| `TIK_INTRO_TARGET_S` | `4.5` (s) | title card window — tells the narrator how long the intro line should be. | <3s = title flashes by; viewers miss pr context. | >6s = boring opening; viewers swipe away. |
| `TIK_OUTRO_TARGET_S` | `4.0` (s) | outro narration window. | <3s = narrator races through the wrap-up. | >5s = drags after the action ends. |
| `TIK_OUTRO_HOLD_S` | `3.5` (s) | extra time the outro Sequence holds AFTER the voice ends so the checklist stays readable. | <2s = reviewers can't finish reading the checklist. | >5s = video feels long; auto-advance laggy. |

</details>

---

## contributing

see [CONTRIBUTING.md](CONTRIBUTING.md). i'm opinionated about my workflow but open to feedback — happy to redesign anything that doesn't fit yours.

```sh
# 1. change code, 2. rebuild, 3. dogfood:
npm run build
OPENAI_API_KEY=... node dist/cli.js run --config examples/todo-app/tiktest.md --quick
```

## license

mit. see [LICENSE](LICENSE).
