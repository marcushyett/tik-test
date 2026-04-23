import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { gh, ghOrThrow, parsePRRef, type PRRef } from "./gh.js";
import { loadConfig } from "./config.js";
import { generatePlan } from "./plan.js";
import { runPlan } from "./runner.js";
import { editSingleVideo } from "./single-video-editor.js";
import { editHighlightReel, renderPreviewGif } from "./editor.js";

export interface PROptions {
  outDir: string;
  voice: string | null;
  music?: string;
  urlOverride?: string;
  assetRepo?: string;        // owner/repo where to upload the video asset (defaults to PR repo)
  skipClone?: boolean;       // run against current working directory (useful for testing locally)
  skipComment?: boolean;     // render the video but don't post to the PR
  vercelBypass?: string;     // VERCEL_AUTOMATION_BYPASS_SECRET for protected previews
  quick?: boolean;
  requirePass?: boolean;     // exit non-zero if any step failed (CI gating)
  review?: "none" | "approve-on-pass" | "request-changes-on-fail" | "always"; // post a formal PR review
}

export async function runForPR(prInput: string, opts: PROptions): Promise<void> {
  const ref = await resolveRef(prInput);
  console.log(chalk.bold(`\n▸ tik-test pr  ${chalk.cyan(`${ref.owner}/${ref.repo}#${ref.number}`)}`));

  // Fetch PR metadata — we need the head repo/branch, author, and previews.
  const meta = await fetchPRMeta(ref);
  console.log(chalk.dim(`  title: ${meta.title}`));
  console.log(chalk.dim(`  head:  ${meta.headRepo}:${meta.headRef}`));

  // Prepare work dir: clone the fork + checkout PR branch.
  let workDir: string;
  let cleanupWorkDir = async () => {};
  if (opts.skipClone) {
    workDir = process.cwd();
    console.log(chalk.dim(`  using current directory: ${workDir}`));
  } else {
    const tmp = await mkdtemp(path.join(os.tmpdir(), `tik-test-pr-${ref.number}-`));
    workDir = tmp;
    cleanupWorkDir = async () => {
      if (!process.env.TIK_KEEP_CLONE) await rm(tmp, { recursive: true, force: true });
    };
    console.log(chalk.dim(`  cloning into ${tmp}…`));
    await ghOrThrow(["repo", "clone", `${ref.owner}/${ref.repo}`, tmp]);
    console.log(chalk.dim(`  fetching PR branch…`));
    // Fetch the PR's ref directly — gh pr checkout can struggle with shallow / tracking setup.
    await runGit(tmp, ["fetch", "origin", `pull/${ref.number}/head:tik-test-pr-${ref.number}`]);
    await runGit(tmp, ["checkout", `tik-test-pr-${ref.number}`]);
  }

  // Locate config (claude.md or README). Prefer claude.md → CLAUDE.md → tik-test.md → README.md.
  const configPath = await findConfig(workDir);
  if (!configPath) {
    throw new Error(`Could not find claude.md or README.md in ${workDir}. Add a claude.md with a URL / setup / focus section for tik-test.`);
  }
  console.log(chalk.dim(`  config: ${path.relative(workDir, configPath)}`));

  const cfg = await loadConfig(configPath, opts.urlOverride ?? meta.previewUrl);
  if (!cfg.focus && meta.body) {
    // Use the PR body as focus context for test plan generation.
    cfg.focus = `PR #${ref.number}: ${meta.title}\n\n${meta.body}`;
  }

  // Read the repo's README for a "TikTest" section — pre-test setup/login
  // instructions. This is the dedicated place repos declare how tik-test
  // should authenticate. We require it: no silent fallback to claude.md login.
  const tiktestSetup = await findTiktestSection(workDir);
  if (tiktestSetup) {
    cfg.tiktestSetup = tiktestSetup;
    console.log(chalk.dim(`  tiktest setup: ${tiktestSetup.split("\n")[0].slice(0, 80)}…`));
  } else {
    console.log(chalk.yellow(`  no "## TikTest" section found in README — running without pre-test setup`));
    console.log(chalk.dim(`    add a "## TikTest Instructions" section to README.md with login steps so the runner can auth itself.`));
  }
  // Feed the PR diff to the plan generator so it can target the exact files
  // and selectors the PR touches — "read the code" exhaustiveness, not just
  // "read the PR body" surface guessing. Truncated to keep us inside the
  // plan-gen context window.
  if (!cfg.diff && !cfg.plan) {
    try {
      const diff = await fetchPRDiff(ref, 18_000);
      if (diff) cfg.diff = diff;
    } catch (e) {
      console.log(chalk.yellow(`  couldn't fetch PR diff (${(e as Error).message.split("\n")[0]}) — planning from PR body only`));
    }
  }

  // If URL still missing, bail with guidance.
  if (!cfg.url) {
    throw new Error(`No testable URL. Set "url:" in your claude.md frontmatter, a "## URL" section, the PR description, or pass --url. Vercel preview URL auto-detection also available.`);
  }

  let serverProc: { kill: () => void } | null = null;
  if (cfg.setup?.toLowerCase().startsWith("start:")) {
    const cmd = cfg.setup.slice(cfg.setup.indexOf(":") + 1).trim().split("\n")[0];
    console.log(chalk.dim(`  starting dev server: ${cmd}`));
    serverProc = spawnBackground(cmd, workDir);
    await waitForUrl(cfg.url, 60_000);
  }

  // Prepare run
  const runId = `pr-${ref.number}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}`;
  const runDir = path.resolve(opts.outDir, runId);
  await mkdir(runDir, { recursive: true });

  try {
    console.log(chalk.bold("\n1/3  generating test plan"));
    const plan = await generatePlan(cfg);
    console.log(chalk.green(`     ✓ plan: ${plan.steps.length} steps — ${plan.name}`));

    console.log(chalk.bold("\n2/3  running tests"));
    const bypass = opts.vercelBypass ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const { extraHTTPHeaders, cookies } = buildVercelBypass(bypass, plan.startUrl);
    if (bypass) console.log(chalk.dim("  vercel protection bypass enabled"));
    const artifacts = await runPlan({ plan, runDir, extraHTTPHeaders, cookies, setupInstructions: cfg.tiktestSetup });
    const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
    console.log(chalk.green(`     ✓ ${artifacts.events.length - failed}/${artifacts.events.length} passed`));

    console.log(chalk.bold("\n3/3  editing highlight reel"));
    const outPath = path.join(runDir, "highlights.mp4");
    await editSingleVideo({
      artifacts, outPath,
      voice: opts.voice,
      quick: opts.quick,
      prTitle: meta.title,
      prBody: meta.body,
      focus: cfg.focus,
    });
    console.log(chalk.green(`     ✓ ${outPath}`));

    // Build the inline-renderable GIF preview alongside the MP4.
    const gifPath = path.join(runDir, "preview.gif");
    console.log(chalk.dim("  rendering inline GIF preview…"));
    await renderPreviewGif(outPath, gifPath);
    console.log(chalk.green(`     ✓ ${gifPath}`));

    const failedCount = artifacts.events.filter((e) => e.outcome === "failure").length;
    if (!opts.skipComment) {
      console.log(chalk.bold("\n4/4  uploading + commenting on PR"));
      const assetRepo = opts.assetRepo ?? `${ref.owner}/${ref.repo}`;
      const { videoUrl, gifUrl } = await uploadRelease(assetRepo, [outPath, gifPath], ref);
      await postPRComment(ref, {
        videoUrl,
        gifUrl,
        plan: plan.name,
        events: artifacts.events,
        totalMs: artifacts.totalMs,
      });
      console.log(chalk.green(`     ✓ commented on ${ref.url}`));

      // Formal PR review for CI gating — asks for changes when tik-test flagged failures.
      const reviewMode = opts.review ?? "request-changes-on-fail";
      if (reviewMode !== "none") {
        const passed = artifacts.events.length - failedCount;
        const shouldApprove = failedCount === 0 && (reviewMode === "approve-on-pass" || reviewMode === "always");
        const shouldRequestChanges = failedCount > 0 && (reviewMode === "request-changes-on-fail" || reviewMode === "always");
        if (shouldApprove || shouldRequestChanges) {
          const reviewBody = shouldApprove
            ? `tik-test approved — ${passed}/${artifacts.events.length} checks green. See the video above for the walk-through.`
            : `tik-test flagged ${failedCount} regression${failedCount === 1 ? "" : "s"} in the video above. Passing ${passed}/${artifacts.events.length} isn't enough — please review the "oops" moments before merging.`;
          const reviewEvent = shouldApprove ? "APPROVE" : "REQUEST_CHANGES";
          const { code } = await gh([
            "pr", "review", String(ref.number),
            "--repo", `${ref.owner}/${ref.repo}`,
            shouldApprove ? "--approve" : "--request-changes",
            "--body", reviewBody,
          ]);
          if (code === 0) console.log(chalk.green(`     ✓ review ${reviewEvent} posted`));
          else console.log(chalk.yellow(`     ! couldn't post review (missing pull-requests:write perm?)`));
        }
      }
    } else {
      console.log(chalk.dim("\n  --skip-comment set — video not posted"));
    }
    if (opts.requirePass && failedCount > 0) {
      throw new Error(`tik-test found ${failedCount} failing step${failedCount === 1 ? "" : "s"} — exiting non-zero for CI gating`);
    }
  } finally {
    if (serverProc) serverProc.kill();
    await cleanupWorkDir();
  }
}

async function resolveRef(input: string): Promise<PRRef> {
  const parsed = parsePRRef(input);
  if (parsed) return parsed;
  // Try interpreting as bare number in current repo.
  if (/^\d+$/.test(input)) {
    const view = await ghOrThrow(["pr", "view", input, "--json", "url,baseRefName"]);
    const json = JSON.parse(view);
    const url = String(json.url);
    const p = parsePRRef(url);
    if (!p) throw new Error(`Could not resolve PR: ${url}`);
    return p;
  }
  throw new Error(`Could not parse PR reference: "${input}". Use a full URL (https://github.com/o/r/pull/N), o/r#N, or a bare PR number while in the repo.`);
}

interface PRMeta {
  title: string;
  body: string;
  headRef: string;
  headRepo: string;
  previewUrl?: string;
}

async function fetchPRMeta(ref: PRRef): Promise<PRMeta> {
  const raw = await ghOrThrow([
    "pr", "view", String(ref.number),
    "--repo", `${ref.owner}/${ref.repo}`,
    "--json", "title,body,headRefName,headRepositoryOwner,headRepository,comments",
  ]);
  const data = JSON.parse(raw);
  const headRepo = `${data.headRepositoryOwner?.login ?? ref.owner}/${data.headRepository?.name ?? ref.repo}`;
  const previewUrl = extractPreviewUrl(data.body ?? "") ?? extractPreviewUrlFromComments(data.comments ?? []);
  return {
    title: data.title ?? "",
    body: data.body ?? "",
    headRef: data.headRefName ?? "",
    headRepo,
    previewUrl,
  };
}

/**
 * Fetch the PR's diff and truncate it to a prompt-safe budget. Large diffs
 * (dependency bumps, generated files) get summarised via a header; we keep
 * the human-authored hunks. Returns `undefined` if the diff is empty or the
 * gh CLI doesn't have diff access.
 */
async function fetchPRDiff(ref: PRRef, maxChars: number): Promise<string | undefined> {
  const { code, stdout } = await gh([
    "pr", "diff", String(ref.number),
    "--repo", `${ref.owner}/${ref.repo}`,
  ]);
  if (code !== 0 || !stdout) return undefined;
  const raw = stdout.trim();
  if (!raw) return undefined;
  if (raw.length <= maxChars) return raw;
  // Truncate but keep the diff valid-looking: cut at a `diff --git` boundary so
  // we don't feed a half-hunk to Claude.
  const truncated = raw.slice(0, maxChars);
  const lastHunk = truncated.lastIndexOf("\ndiff --git ");
  const cut = lastHunk > maxChars * 0.4 ? lastHunk : truncated.length;
  const dropped = raw.length - cut;
  return `${raw.slice(0, cut)}\n\n[... ${dropped.toLocaleString()} more characters of diff omitted — consider testing the omitted files manually if they're user-facing]`;
}

function extractPreviewUrl(body: string): string | undefined {
  // Vercel posts tables with preview URLs. Match bare URLs.
  const vercel = /https?:\/\/[a-z0-9-]+\.vercel\.app(?:\/\S*)?/i.exec(body);
  if (vercel) return vercel[0];
  const netlify = /https?:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app(?:\/\S*)?/i.exec(body);
  if (netlify) return netlify[0];
  const custom = /Preview:\s*(https?:\/\/\S+)/i.exec(body);
  if (custom) return custom[1];
  return undefined;
}

function extractPreviewUrlFromComments(comments: Array<{ body?: string }>): string | undefined {
  for (const c of comments) {
    const url = extractPreviewUrl(c.body ?? "");
    if (url) return url;
  }
  return undefined;
}

async function findConfig(workDir: string): Promise<string | null> {
  const candidates = ["claude.md", "CLAUDE.md", ".claude/claude.md", "tik-test.md", "README.md"];
  for (const rel of candidates) {
    const full = path.join(workDir, rel);
    try {
      const s = await stat(full);
      if (s.isFile()) return full;
    } catch {}
  }
  return null;
}

/**
 * Extract the "TikTest" (or similar) section from the repo's README. This is
 * where the repo author documents how tik-test should sign in and prep the
 * test environment — the instructions are natural language, and a pre-test
 * setup phase translates them to Playwright actions.
 *
 * Returns the section body (without the heading) or null if no matching
 * section was found.
 */
async function findTiktestSection(workDir: string): Promise<string | null> {
  const candidates = ["README.md", "readme.md", "Readme.md"];
  for (const rel of candidates) {
    const full = path.join(workDir, rel);
    let raw: string;
    try { raw = await readFile(full, "utf8"); } catch { continue; }
    const aliases = [
      /^##\s+tik[- ]?test\s+instructions?\s*$/i,
      /^##\s+tik[- ]?test\b.*$/i,
      /^##\s+testing\s+with\s+tik[- ]?test\s*$/i,
      /^##\s+tik[- ]?test\s+setup\s*$/i,
    ];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (aliases.some((re) => re.test(lines[i]))) {
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^##\s+/.test(lines[j])) break;
          body.push(lines[j]);
        }
        const section = body.join("\n").trim();
        if (section) return section;
      }
    }
  }
  return null;
}

function buildVercelBypass(secret: string | undefined, url: string): { extraHTTPHeaders?: Record<string, string>; cookies?: Array<any> } {
  if (!secret) return {};
  let host: string | undefined;
  try { host = new URL(url).hostname; } catch {}
  const cookies = host ? [
    { name: "__vercel_protection_bypass", value: secret, domain: host, path: "/" },
    { name: "x-vercel-protection-bypass", value: secret, domain: host, path: "/" },
  ] : undefined;
  return {
    extraHTTPHeaders: { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "samesitenone" },
    cookies,
  };
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${err}`))));
  });
}

function spawnBackground(cmd: string, cwd: string): { kill: () => void } {
  const child = spawn("bash", ["-lc", cmd], { cwd, stdio: "inherit", detached: true });
  return {
    kill: () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
    },
  };
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Dev server at ${url} didn't respond within ${timeoutMs}ms.`);
}

async function uploadRelease(assetRepo: string, filePaths: string[], ref: PRRef): Promise<{ videoUrl: string; gifUrl?: string }> {
  const tagBase = "tik-test-reviews";
  const tag = `${tagBase}-pr${ref.number}-${Date.now()}`;
  const title = `tik-test review — PR #${ref.number}`;
  const notes = `Auto-generated video review of PR #${ref.number} in ${ref.owner}/${ref.repo}.`;
  const { code, stderr } = await gh([
    "release", "create", tag,
    "--repo", assetRepo,
    "--title", title,
    "--notes", notes,
    "--prerelease",
    ...filePaths,
  ]);
  if (code !== 0) throw new Error(`gh release create failed: ${stderr}`);
  const listRaw = await ghOrThrow([
    "release", "view", tag,
    "--repo", assetRepo,
    "--json", "assets",
  ]);
  const assets = JSON.parse(listRaw).assets as Array<{ name: string; apiUrl: string; url: string; browser_download_url?: string }>;
  const lookup = (name: string) => {
    const a = assets.find((x) => x.name === name);
    if (!a) return undefined;
    return a.url ?? a.browser_download_url ?? `https://github.com/${assetRepo}/releases/download/${tag}/${name}`;
  };
  const videoName = filePaths.find((p) => /\.mp4$/i.test(p));
  const gifName = filePaths.find((p) => /\.gif$/i.test(p));
  const videoUrl = videoName ? lookup(path.basename(videoName)) : undefined;
  const gifUrl = gifName ? lookup(path.basename(gifName)) : undefined;
  if (!videoUrl) throw new Error("Failed to resolve uploaded MP4 asset URL");
  return { videoUrl, gifUrl };
}

interface CommentData {
  videoUrl: string;
  gifUrl?: string;
  plan: string;
  events: Array<{ description: string; outcome: string; error?: string; importance: string; startMs: number; endMs: number }>;
  totalMs: number;
  runId?: string;
}

/**
 * Versioned HTML-comment marker that the review web app scans for.
 * The app trusts a comment ONLY if:
 *   1. The outer `<!-- tik-test-video:v1 … -->` wrapper is present AND parseable JSON.
 *   2. The payload's videoUrl is a GitHub release-asset path (github.com/.../releases/download/...).
 *   3. The outer comment author matches the bot / user who ran the action (checked on the client).
 * Keeping this terse + versioned lets the schema evolve without breaking old comments.
 */
const MARKER_VERSION = "1";
function buildTikTestMarker(data: CommentData, meta: { prRef: string; ts: string }): string {
  const payload = {
    v: MARKER_VERSION,
    runId: data.runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    prRef: meta.prRef,
    createdAt: meta.ts,
    planName: data.plan,
    videoUrl: data.videoUrl,
    gifUrl: data.gifUrl,
    totalMs: data.totalMs,
    stats: {
      total: data.events.length,
      passed: data.events.filter((e) => e.outcome === "success").length,
      failed: data.events.filter((e) => e.outcome === "failure").length,
      skipped: data.events.filter((e) => e.outcome === "skipped").length,
    },
  };
  return `<!-- tik-test-video:v${MARKER_VERSION} ${JSON.stringify(payload)} -->`;
}

async function postPRComment(ref: PRRef, data: CommentData): Promise<void> {
  const failed = data.events.filter((e) => e.outcome === "failure");
  const passed = data.events.length - failed.length - data.events.filter((e) => e.outcome === "skipped").length;
  const status = failed.length === 0 ? "All green" : `${failed.length} step${failed.length === 1 ? "" : "s"} failed`;

  const bulletFor = (e: CommentData["events"][number], i: number) => {
    const mark = e.outcome === "failure" ? "FAIL" : e.outcome === "skipped" ? "skip" : (e.importance === "critical" || e.importance === "high") ? "PASS" : "ok";
    const err = e.error ? ` — \`${e.error}\`` : "";
    return `- \`${mark.padEnd(4)}\` **${String(i + 1).padStart(2, "0")}** ${e.description}${err}`;
  };
  const stepsMd = data.events.map(bulletFor).join("\n");

  const preview = data.gifUrl
    // Inline GIF renders animated on GitHub. Wrap it in a link to the full MP4 so clicking it opens the download.
    ? `<a href="${data.videoUrl}"><img src="${data.gifUrl}" alt="tik-test review" width="360" /></a>`
    // Fallback: <video> tag (may degrade to a download link depending on GitHub rendering rules for release assets).
    : `<video src="${data.videoUrl}" controls width="480"></video>`;

  const marker = buildTikTestMarker(data, {
    prRef: `${ref.owner}/${ref.repo}#${ref.number}`,
    ts: new Date().toISOString(),
  });

  const body = [
    marker,
    ``,
    `### tik-test review — ${status}`,
    ``,
    `**${data.plan}** — ${passed}/${data.events.length} checks passed in ${(data.totalMs / 1000).toFixed(1)}s.`,
    ``,
    preview,
    ``,
    `_The preview above loops silently — open the MP4 for the narrated version._`,
    ``,
    `**[Play full video (MP4, with voice-over)](${data.videoUrl})**`,
    ``,
    `<details><summary>Run transcript</summary>`,
    ``,
    stepsMd,
    ``,
    `</details>`,
    ``,
    `---`,
    `Generated by [tik-test](https://github.com/marcushyett/tik-test). Re-run with \`tik-test pr ${ref.number}\`.`,
  ].join("\n");

  await ghOrThrow([
    "pr", "comment", String(ref.number),
    "--repo", `${ref.owner}/${ref.repo}`,
    "--body-file", "-",
  ], { input: body });

  // Best-effort: add a label so reviewers can filter.
  await gh([
    "pr", "edit", String(ref.number),
    "--repo", `${ref.owner}/${ref.repo}`,
    "--add-label", "tik-test-reviewed",
  ]).catch(() => {});
}
