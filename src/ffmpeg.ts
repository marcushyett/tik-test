import { spawn } from "node:child_process";

export interface FfmpegResult { stdout: string; stderr: string }

export function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    if (process.env.TIK_FFMPEG_DEBUG) {
      console.error("[ffmpeg]", args.map((a) => (a.includes(" ") || a.includes(";") ? JSON.stringify(a) : a)).join(" "));
    }
    const child = spawn("ffmpeg", ["-hide_banner", "-y", "-loglevel", "error", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      resolve({ stdout, stderr });
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

