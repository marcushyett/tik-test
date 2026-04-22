import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { gh, ghOrThrow, parsePRRef, type PRRef } from "./gh.js";
import { loadConfig } from "./config.js";
import { generatePlan } from "./plan.js";
import { runPlan } from "./runner.js";
import { editHighlightReel, renderPreviewGif } from "./editor.js";

export interface PROptions {
  outDir: string;
  voice: string | null;
  music?: string;
  urlOverride?: string;
  assetRepo?: string;       // owner/repo where to upload the video asset (defaults to PR repo)
  skipClone?: boolean;      // run against current working directory (useful for testing locally)
  skipComment?: boolean;    // render the video but don't post to the PR
}

export async function runForPR(prInput: string, opts: PROptions): Promise<void> {
  const ref = await resolveRef(prInput);
  console.log(chalk.bold(`\n🎬 tik-test pr  ${chalk.cyan(`${ref.owner}/${ref.repo}#${ref.number}`)}`));

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
    const artifacts = await runPlan({ plan, runDir });
    const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
    console.log(chalk.green(`     ✓ ${artifacts.events.length - failed}/${artifacts.events.length} passed`));

    console.log(chalk.bold("\n3/3  editing highlight reel"));
    const outPath = path.join(runDir, "highlights.mp4");
    await editHighlightReel({ artifacts, outPath, musicPath: cfg.music ?? opts.music, voice: opts.voice });
    console.log(chalk.green(`     ✓ ${outPath}`));

    // Build the inline-renderable GIF preview alongside the MP4.
    const gifPath = path.join(runDir, "preview.gif");
    console.log(chalk.dim("  rendering inline GIF preview…"));
    await renderPreviewGif(outPath, gifPath);
    console.log(chalk.green(`     ✓ ${gifPath}`));

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
    } else {
      console.log(chalk.dim("\n  --skip-comment set — video not posted"));
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
}

async function postPRComment(ref: PRRef, data: CommentData): Promise<void> {
  const failed = data.events.filter((e) => e.outcome === "failure");
  const passed = data.events.length - failed.length - data.events.filter((e) => e.outcome === "skipped").length;
  const emoji = failed.length === 0 ? "✅" : "⚠️";
  const status = failed.length === 0 ? "All green" : `${failed.length} step${failed.length === 1 ? "" : "s"} failed`;

  const bulletFor = (e: CommentData["events"][number], i: number) => {
    const mark = e.outcome === "failure" ? "❌" : e.outcome === "skipped" ? "·" : (e.importance === "critical" ? "⭐" : e.importance === "high" ? "✨" : "✓");
    const err = e.error ? ` — \`${e.error}\`` : "";
    return `- ${mark} **${String(i + 1).padStart(2, "0")}** ${e.description}${err}`;
  };
  const stepsMd = data.events.map(bulletFor).join("\n");

  const preview = data.gifUrl
    // Inline GIF renders animated on GitHub. Wrap it in a link to the full MP4 so clicking it opens the download.
    ? `<a href="${data.videoUrl}"><img src="${data.gifUrl}" alt="tik-test review" width="360" /></a>`
    // Fallback: <video> tag (may degrade to a download link depending on GitHub rendering rules for release assets).
    : `<video src="${data.videoUrl}" controls width="480"></video>`;

  const body = [
    `### 🎬 tik-test review — ${emoji} ${status}`,
    ``,
    `**${data.plan}** — ${passed}/${data.events.length} steps passed in ${(data.totalMs / 1000).toFixed(1)}s.`,
    ``,
    preview,
    ``,
    `_The preview above loops silently — open the MP4 for the narrated version._`,
    ``,
    `▶ [Play full video (MP4, with voice-over)](${data.videoUrl})`,
    ``,
    `<details><summary>Test steps</summary>`,
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
