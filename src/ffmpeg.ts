import { spawn } from "node:child_process";

export interface FfmpegResult { stdout: string; stderr: string }

/** Throttle progress lines to one every PROGRESS_INTERVAL_MS. Live `\r`-
 *  rewriting works in a TTY but produces hundreds of `^M`-laden lines in
 *  CI logs; throttling gives a usable middle ground (one `frame=…` line
 *  every few seconds in either context). */
const PROGRESS_INTERVAL_MS = 5_000;

export function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    if (process.env.TIK_FFMPEG_DEBUG) {
      console.error("[ffmpeg]", args.map((a) => (a.includes(" ") || a.includes(";") ? JSON.stringify(a) : a)).join(" "));
    }
    // -loglevel error suppresses the verbose info chatter; -stats keeps
    // the rate-limited "frame=… fps=… size=…" progress line. So users
    // see life signs during long encodes (a 73-segment master can take
    // 5-15 min on a CI runner — silent before this change).
    const showProgress = process.env.TIK_FFMPEG_PROGRESS !== "0";
    const baseArgs = ["-hide_banner", "-y", "-loglevel", "error"];
    if (showProgress) baseArgs.push("-stats");
    const child = spawn("ffmpeg", [...baseArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let lastProgressEmitMs = 0;
    let lastProgressLine = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => {
      const chunk = b.toString();
      stderr += chunk;
      if (!showProgress) return;
      // ffmpeg's stats writes to stderr with `\r` to overwrite. Split on
      // both `\r` and `\n`, take the latest non-empty fragment as the
      // current state, and emit it at most every PROGRESS_INTERVAL_MS.
      const fragments = chunk.split(/[\r\n]/).filter((f: string) => f.trim().length > 0);
      if (fragments.length === 0) return;
      lastProgressLine = fragments[fragments.length - 1];
      const now = Date.now();
      if (now - lastProgressEmitMs >= PROGRESS_INTERVAL_MS) {
        process.stderr.write(`  ${lastProgressLine}\n`);
        lastProgressEmitMs = now;
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      // Print the final stats line so the user sees the completion state
      // (last throttled emit might be 4s before the close event).
      if (showProgress && lastProgressLine && Date.now() - lastProgressEmitMs > 1_000) {
        process.stderr.write(`  ${lastProgressLine}\n`);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Detect frames where the visual content changed significantly. Used by the
 * editor's content-aware trim planner: every scenechange becomes an anchor
 * around which we keep the raw video at 1×, while the gaps between anchors
 * get aggressively compressed. This catches transitions our interaction
 * stream misses — async data loading in, route changes, dialogs opening,
 * skeleton-to-content swaps.
 *
 * Implementation: ffmpeg's `select='gt(scene,T)',showinfo` filter writes one
 * info line per frame whose scene-difference score exceeds the threshold.
 * We parse `pts_time:` from those lines. Failure mode is benign — on any
 * parse error we return [] and the editor falls back to interaction +
 * tool-anchor-only mode (still fine, just less precise).
 */
export function detectScenechanges(file: string, threshold = 0.10): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-i", file,
      "-filter:v", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const times: number[] = [];
      const re = /pts_time:([0-9.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (Number.isFinite(t)) times.push(t);
      }
      times.sort((a, b) => a - b);
      resolve(times);
    });
  });
}

export function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      const n = parseFloat(out.trim());
      if (!isFinite(n)) return reject(new Error(`Bad duration: ${out}`));
      resolve(n);
    });
  });
}

