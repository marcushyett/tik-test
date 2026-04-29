import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import chalk from "chalk";
import { resolveConfigPath, type ConfigSource } from "./pr.js";

/** A single check's result. `level` controls icon + exit code: any
 *  `error` makes `tik-test doctor` exit non-zero so it can be wired
 *  into pre-push hooks if a user wants. */
export type CheckLevel = "ok" | "warn" | "error";
export interface CheckResult {
  level: CheckLevel;
  title: string;
  detail?: string;
  fixHint?: string;
}

export interface DoctorOptions {
  cwd: string;
}

/** Aggregated doctor output. Returned by `runDoctor` so other code (e.g.
 *  the Claude Code plugin's setup skill) can consume the JSON instead
 *  of parsing terminal output. */
export interface DoctorReport {
  cwd: string;
  checks: CheckResult[];
  summary: { ok: number; warn: number; error: number };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  checks.push(await checkConfigFile(opts.cwd));
  checks.push(await checkPreviewUrlReachable(opts.cwd));
  checks.push(...(await checkClaudeAuth()));
  checks.push(await checkWorkflowFile(opts.cwd));
  checks.push(...checkOptionalSecrets());

  const summary = {
    ok: checks.filter((c) => c.level === "ok").length,
    warn: checks.filter((c) => c.level === "warn").length,
    error: checks.filter((c) => c.level === "error").length,
  };
  return { cwd: opts.cwd, checks, summary };
}

export function printDoctorReport(report: DoctorReport): void {
  console.log(chalk.bold(`\ntik-test doctor — ${report.cwd}\n`));
  for (const c of report.checks) {
    const icon = c.level === "ok" ? chalk.green("✓") : c.level === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
    console.log(`  ${icon} ${c.title}`);
    if (c.detail) console.log(`      ${chalk.dim(c.detail)}`);
    if (c.fixHint) console.log(`      ${chalk.cyan("fix:")} ${chalk.dim(c.fixHint)}`);
  }
  const { ok, warn, error } = report.summary;
  console.log("");
  console.log(chalk.dim(`  ${report.checks.length} checks · ${ok} ok · ${warn} warnings · ${error} errors`));
  if (error === 0 && warn === 0) {
    console.log(chalk.green(`  → tik-test should run cleanly on this repo.`));
  } else if (error === 0) {
    console.log(chalk.yellow(`  → tik-test should run but verify the warnings above.`));
  } else {
    console.log(chalk.red(`  → fix the errors above before running tik-test.`));
  }
}

// ── Individual checks ────────────────────────────────────────────────

async function checkConfigFile(cwd: string): Promise<CheckResult> {
  const resolved = await resolveConfigPath(cwd);
  if (!resolved) {
    return {
      level: "error",
      title: `config file: not found in ${cwd}`,
      fixHint: `create tiktest.md at the repo root with: app description, login (if any), and risky surfaces. See https://github.com/marcushyett/tik-test for the format.`,
    };
  }
  const rel = path.relative(cwd, resolved.path);
  if (resolved.source === "dedicated") {
    return { level: "ok", title: `config file: ${rel}`, detail: `dedicated tiktest.md (preferred)` };
  }
  const reasonByLevel: Record<Exclude<ConfigSource, "dedicated">, string> = {
    "readme-section": `falling back to README.md ## TikTest section — works but tiktest.md is more explicit`,
    "legacy-claude": `falling back to ${rel} — tik-test prefers tiktest.md but couldn't find one`,
    "bare-readme": `falling back to bare ${rel} — no testing section detected, plan generation will be lossy`,
  };
  return {
    level: "warn",
    title: `config file: ${rel}`,
    detail: reasonByLevel[resolved.source],
    fixHint: `add tiktest.md at ${cwd} (a fresh dedicated file) — pass --strict-config to make this a hard error`,
  };
}

async function checkPreviewUrlReachable(cwd: string): Promise<CheckResult> {
  // Lazy load — only valuable if the config has a url to begin with.
  const resolved = await resolveConfigPath(cwd);
  if (!resolved) return { level: "warn", title: `preview URL: skipped (no config file)` };
  let url: string | undefined;
  try {
    const raw = await readFile(resolved.path, "utf8");
    const m = raw.match(/https?:\/\/\S+/);
    if (m) url = m[0].replace(/[)\].,]+$/, "");
  } catch {}
  if (!url) {
    return {
      level: "warn",
      title: `preview URL: not found in config`,
      detail: `no http(s) URL in ${path.relative(cwd, resolved.path)} — fine if CI auto-detects it from a Vercel preview, otherwise add 'url:' or paste a URL anywhere in the file.`,
    };
  }
  const probe = await probeUrl(url);
  if (probe.ok) {
    return { level: "ok", title: `preview URL: ${url}`, detail: `HTTP ${probe.status} ${probe.contentType ?? ""}` };
  }
  if (probe.vercelSso) {
    return {
      level: "error",
      title: `preview URL: ${url} — blocked by Vercel SSO`,
      detail: `${probe.status} ${probe.contentType ?? ""} → Vercel Deployment Protection is on`,
      fixHint: `add VERCEL_AUTOMATION_BYPASS_SECRET as a GitHub secret (Vercel project Settings → Deployment Protection → Protection Bypass for Automation)`,
    };
  }
  return {
    level: "warn",
    title: `preview URL: ${url} — HTTP ${probe.status}`,
    detail: probe.error ?? `unexpected status — the agent may not be able to load the page`,
    fixHint: `verify the URL loads in a browser and that any auth bypass tokens are configured`,
  };
}

async function checkClaudeAuth(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const onPath = await isOnPath("claude");
  if (!onPath) {
    checks.push({
      level: "error",
      title: `claude CLI: not on PATH`,
      fixHint: `npm install -g @anthropic-ai/claude-code`,
    });
    return checks;
  }
  const version = await runCmd("claude", ["--version"], 5_000);
  checks.push({
    level: "ok",
    title: `claude CLI: installed`,
    detail: version.stdout.trim() || version.stderr.trim() || "(no version output)",
  });
  // Auth check: rely on env var presence, not a live API call (it would
  // burn tokens just to ping). The action also exports the token onto
  // every subprocess so the env-var heuristic mirrors what the spawned
  // narrator subprocess will see.
  const haveOauth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const haveApiKey = !!process.env.ANTHROPIC_API_KEY;
  if (haveOauth) {
    checks.push({ level: "ok", title: `claude auth: CLAUDE_CODE_OAUTH_TOKEN env set` });
  } else if (haveApiKey) {
    checks.push({ level: "ok", title: `claude auth: ANTHROPIC_API_KEY env set`, detail: `pay-per-use; OAuth via Claude Max is the recommended path` });
  } else {
    checks.push({
      level: "error",
      title: `claude auth: no token in env`,
      detail: `tik-test spawns claude as a subprocess; it inherits env vars only`,
      fixHint: `export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token | tail -1) — or set it as a GitHub secret`,
    });
  }
  return checks;
}

async function checkWorkflowFile(cwd: string): Promise<CheckResult> {
  const wfDir = path.join(cwd, ".github", "workflows");
  let entries: string[] = [];
  try {
    entries = await readdir(wfDir);
  } catch {
    return {
      level: "warn",
      title: `workflow file: no .github/workflows/`,
      fixHint: `copy a template from https://github.com/marcushyett/tik-test/tree/main/templates/workflows`,
    };
  }
  const candidates = entries.filter((f) => /tik[-_]?test/i.test(f) && /\.ya?ml$/.test(f));
  if (candidates.length === 0) {
    return {
      level: "warn",
      title: `workflow file: no tik-test*.yml under .github/workflows/`,
      fixHint: `copy a template from https://github.com/marcushyett/tik-test/tree/main/templates/workflows`,
    };
  }
  // Inspect the first match for action version pinning.
  const wfPath = path.join(wfDir, candidates[0]);
  const raw = await readFile(wfPath, "utf8");
  const usesMatch = raw.match(/uses:\s*marcushyett\/tik-test@(\S+)/);
  if (!usesMatch) {
    return {
      level: "ok",
      title: `workflow file: ${path.relative(cwd, wfPath)}`,
      detail: `(uses: ./ — local action, can't check version)`,
    };
  }
  const version = usesMatch[1];
  if (version === "v1" || version.startsWith("v1.")) {
    return { level: "ok", title: `workflow file: ${path.relative(cwd, wfPath)}`, detail: `pinned to ${version}` };
  }
  return {
    level: "warn",
    title: `workflow file: ${path.relative(cwd, wfPath)}`,
    detail: `pinned to ${version}; consider @v1 for the latest tested release`,
  };
}

function checkOptionalSecrets(): CheckResult[] {
  const checks: CheckResult[] = [];
  if (process.env.OPENAI_API_KEY) {
    checks.push({ level: "ok", title: `OPENAI_API_KEY: set (TTS narration enabled)` });
  } else {
    checks.push({ level: "warn", title: `OPENAI_API_KEY: unset`, detail: `videos will be silent on Linux runners (no system 'say' command available)` });
  }
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    checks.push({ level: "ok", title: `VERCEL_AUTOMATION_BYPASS_SECRET: set` });
  } else {
    checks.push({ level: "warn", title: `VERCEL_AUTOMATION_BYPASS_SECRET: unset`, detail: `only needed if your Vercel preview has Deployment Protection on` });
  }
  return checks;
}

// ── Plumbing ──────────────────────────────────────────────────────────

interface ProbeResult { ok: boolean; status?: number; contentType?: string; vercelSso?: boolean; error?: string }
async function probeUrl(url: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch (e) {
      return resolve({ ok: false, error: `invalid URL: ${(e as Error).message}` });
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "HEAD", timeout: 8_000 }, (res) => {
      const status = res.statusCode ?? 0;
      const ct = (res.headers["content-type"] as string | undefined)?.split(";")[0].trim();
      // Vercel SSO redirects to an HTML login page. Heuristic: 401/403/redirect chain to vercel.com/login or vercel.app/_vercel/sso/.
      const location = res.headers["location"] as string | undefined;
      const vercelSso = !!(location && /vercel\.com\/.+sso|vercel\.app\/_vercel\/sso/i.test(location)) || (status === 401 && !!ct?.includes("text/html"));
      const ok = status >= 200 && status < 400 && !vercelSso;
      resolve({ ok, status, contentType: ct, vercelSso });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: `timed out after 8s` }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

async function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: -1, stdout, stderr: stderr + `\n[killed after ${timeoutMs}ms]` }); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
