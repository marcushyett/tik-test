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
