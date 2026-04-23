#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { generatePlan } from "./plan.js";
import { runPlan } from "./runner.js";
import { editHighlightReel } from "./editor.js";
import { editSingleVideo } from "./single-video-editor.js";
import { startViewer } from "./viewer.js";
import { runForPR } from "./pr.js";

const program = new Command();
program
  .name("tik-test")
  .description("TikTok-style automated video testing for UI feature reviews.")
  .version("0.1.0");

program
  .command("run")
  .description("Run a test plan against a URL and produce a TikTok-style highlight video")
  .requiredOption("-c, --config <path>", "path to claude.md config", "claude.md")
  .option("-u, --url <url>", "override URL from config")
  .option("-o, --out-dir <dir>", "output directory", "runs")
  .option("--headed", "run browser in headed mode")
  .option("--music <path>", "optional audio file to mix under the video")
  .option("--voice <name>", "macOS `say` voice name for narration", "Samantha")
  .option("--no-voice", "disable narration voice-over")
  .option("--quick", "low-resolution draft render for quicker iteration")
  .option("--legacy-reel", "use the old per-step clip slicer instead of the single-video overlay pipeline")
  .option("--vercel-bypass <secret>", "Vercel Protection Bypass secret (also: VERCEL_AUTOMATION_BYPASS_SECRET env)")
  .option("--open", "start the viewer after the run completes")
  .action(async (opts) => {
    const cfg = await loadConfig(opts.config, opts.url);
    if (opts.music) cfg.music = opts.music;
    const runId = `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}`;
    const runDir = path.resolve(opts.outDir, runId);
    await mkdir(runDir, { recursive: true });

    console.log(chalk.bold(`\n🎬 tik-test  ${chalk.dim(runId)}`));
    console.log(chalk.dim(`  target: ${cfg.url}`));

    console.log(chalk.bold("\n1/3  generating test plan"));
    const plan = await generatePlan(cfg);
    console.log(chalk.green(`     ✓ plan: ${plan.steps.length} steps — ${plan.name}`));

    console.log(chalk.bold("\n2/3  running tests"));
    const bypass = opts.vercelBypass || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const { extraHTTPHeaders, cookies } = buildVercelBypass(bypass, plan.startUrl);
    const artifacts = await runPlan({ plan, runDir, headed: opts.headed, extraHTTPHeaders, cookies });
    const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
    console.log(chalk.green(`     ✓ ${artifacts.events.length - failed}/${artifacts.events.length} passed, raw ${path.relative(process.cwd(), artifacts.rawVideoPath)}`));

    console.log(chalk.bold("\n3/3  editing highlight reel"));
    const outPath = path.join(runDir, "highlights.mp4");
    const voice = opts.voice === false ? null : (opts.voice as string);
    if (opts.legacyReel) {
      await editHighlightReel({
        artifacts, outPath,
        musicPath: cfg.music,
        voice,
        quick: !!opts.quick,
        focus: cfg.focus,
        prTitle: cfg.name,
      });
    } else {
      await editSingleVideo({
        artifacts, outPath,
        voice,
        quick: !!opts.quick,
        focus: cfg.focus,
        prTitle: cfg.name,
      });
    }
    console.log(chalk.green(`     ✓ ${path.relative(process.cwd(), outPath)}`));

    console.log(chalk.bold("\n✨ done"));
    console.log(`  video:  ${chalk.underline(outPath)}`);
    console.log(`  events: ${chalk.underline(artifacts.eventsJsonPath)}`);

    if (opts.open) {
      process.env.TIK_RUNS_DIR = path.resolve(opts.outDir);
      await startViewer(Number(process.env.PORT ?? 5173));
    }
  });

program
  .command("pr")
  .argument("<pr>", "PR reference: URL, owner/repo#number, or bare number in a repo")
  .description("Run tik-test against a GitHub pull request, then comment back with the video")
  .option("-o, --out-dir <dir>", "output directory", "runs")
  .option("-u, --url <url>", "override the target URL (skips preview-URL detection)")
  .option("--music <path>", "optional audio file to mix under the video")
  .option("--voice <name>", "macOS `say` voice for narration", "Samantha")
  .option("--no-voice", "disable narration")
  .option("--asset-repo <owner/repo>", "repo to upload the video release asset to (default: PR repo)")
  .option("--skip-clone", "run against the current working directory instead of cloning")
  .option("--skip-comment", "render the video but don't post a PR comment")
  .option("--vercel-bypass <secret>", "Vercel Protection Bypass secret (also: VERCEL_AUTOMATION_BYPASS_SECRET env)")
  .option("--quick", "low-resolution draft render")
  .action(async (pr, opts) => {
    const voice = opts.voice === false ? null : (opts.voice as string);
    await runForPR(pr, {
      outDir: opts.outDir,
      voice,
      music: opts.music,
      urlOverride: opts.url,
      assetRepo: opts.assetRepo,
      skipClone: !!opts.skipClone,
      skipComment: !!opts.skipComment,
      vercelBypass: opts.vercelBypass,
      quick: !!opts.quick,
    });
  });

program
  .command("view")
  .description("Start the web viewer to watch produced videos")
  .option("-d, --dir <dir>", "runs directory", "runs")
  .option("-p, --port <port>", "port", "5173")
  .action(async (opts) => {
    process.env.TIK_RUNS_DIR = path.resolve(opts.dir);
    await startViewer(Number(opts.port));
  });

function buildVercelBypass(secret: string | undefined, url: string): { extraHTTPHeaders?: Record<string, string>; cookies?: Array<any> } {
  if (!secret) return {};
  // The combination of header + cookie covers both the initial HTML request AND
  // subsequent XHR / video asset fetches from the Vercel preview host.
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

program.parseAsync().catch((e: Error) => {
  console.error(chalk.red(`\nerror: ${e.message}`));
  process.exit(1);
});
