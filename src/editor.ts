import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import { runFfmpeg, ffprobeDuration } from "./ffmpeg.js";
import { narrate } from "./narrator.js";
import type { RunArtifacts, StepEvent, PlanStep, BBox } from "./types.js";

// Output canvas (TikTok / Reels)
const OUT_W = 1080;
const OUT_H = 1920;
const FPS = 30;

// The browser clip is laid out in a centered band of this width/height.
const INNER_W = OUT_W - 40; // 1040
const INNER_H_FOR_16_9 = Math.round(INNER_W * 9 / 16); // 585

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
];

async function findFont(): Promise<string | null> {
  for (const f of FONT_CANDIDATES) {
    try {
      await stat(f);
      return f;
    } catch {}
  }
  return null;
}

function speedFor(ev: StepEvent): number {
  if (ev.outcome === "failure") return 0.45;
  if (ev.kind === "wait") return 2.0;
  if (ev.importance === "critical") return 0.5;
  if (ev.importance === "high") return 0.7;
  if (ev.kind === "assert-visible" || ev.kind === "assert-text") return 0.85;
  return 0.9;
}

function colorFor(ev: StepEvent): { primary: string; accent: string } {
  if (ev.outcome === "failure") return { primary: "0xff4444", accent: "0xffffff" };
  if (ev.outcome === "skipped") return { primary: "0xaaaaaa", accent: "0xffffff" };
  if (ev.importance === "critical") return { primary: "0xffd04a", accent: "0x0a0a0a" };
  if (ev.importance === "high") return { primary: "0x00e5a0", accent: "0x0a0a0a" };
  return { primary: "0xffffff", accent: "0x0a0a0a" };
}

function wrapCaption(text: string, max: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

function ffEscapePath(p: string): string {
  const inner = p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return `'${inner.replace(/'/g, "'\\''")}'`;
}

function sanitiseForSpeech(s: string): string {
  // Strip emoji/symbols that speech might say literally
  return s
    .replace(/[✓✗⚠✨📸]/g, "")
    .replace(/—/g, "-")
    .replace(/·/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function runSay(text: string, outAiff: string, voice: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("say", ["-v", voice, "-o", outAiff, "--data-format=LEI16@22050", text], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`say exited ${code}: ${err}`))));
  });
}

/**
 * Compute the zoom target: centroid and a zoom multiplier based on element size.
 * Bigger elements get modest zoom (to keep context), tiny elements get a bit more.
 */
function computeZoomTarget(bbox: BBox | undefined, importance?: string): null | { cx: number; cy: number; vw: number; vh: number; targetZ: number } {
  if (!bbox) return null;
  const vw = bbox.viewportWidth;
  const vh = bbox.viewportHeight;
  if (!vw || !vh) return null;
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  // How big is the element relative to the viewport? If it's already large, barely zoom.
  const relSize = Math.max(bbox.width / vw, bbox.height / vh);
  // Base zoom: 1.6 for small controls → 1.15 for large regions.
  let targetZ = 1.15 + (1 - Math.min(1, relSize * 3)) * 0.45;
  if (importance === "critical") targetZ += 0.1;
  if (importance === "high") targetZ += 0.05;
  targetZ = Math.max(1.1, Math.min(1.7, targetZ));
  return { cx, cy, vw, vh, targetZ };
}

interface SegmentContext {
  ev: StepEvent;
  idx: number;
  total: number;
  step?: PlanStep;
  planStartUrl: string;
  sliceStartS: number;
  sliceDurS: number;
}

interface RenderedSegment {
  file: string;
  durationS: number;
}

async function renderSegment(
  raw: string,
  rawDuration: number,
  ctx: SegmentContext,
  outFile: string,
  font: string | null,
  textDir: string,
  voice: string | null,
): Promise<RenderedSegment> {
  const { ev, idx, total, planStartUrl, sliceStartS, sliceDurS } = ctx;

  const narration = narrate({
    step: ctx.step ?? ({ id: ev.stepId, kind: ev.kind, description: ev.description, importance: ev.importance } as PlanStep),
    outcome: ev.outcome,
    error: ev.error,
    notes: ev.notes,
    seed: idx,
    index: idx,
    total,
    startUrl: planStartUrl,
  });

  // Voice-over audio
  let voiceDur = 0;
  const voicePath = path.join(textDir, `${idx}-voice.aiff`);
  if (voice) {
    try {
      await runSay(sanitiseForSpeech(narration.line), voicePath, voice);
      voiceDur = await ffprobeDuration(voicePath);
    } catch (e) {
      voiceDur = 0;
    }
  }

  // Segment duration: honour narration length + minimum dwell for each importance level.
  const minDwell = ev.outcome === "failure" ? 4.5 : ev.importance === "critical" ? 3.8 : ev.importance === "high" ? 3.0 : 2.5;
  const segDur = Math.max(minDwell, voiceDur + 1.0);

  // Speed of playback = sliceDur / segDur so the slice exactly fills the segment at a steady pace.
  // We clamp to a reasonable range so important steps slow down visibly, and wait-heavy steps don't drag.
  const natural = sliceDurS / segDur;
  const speed = Math.max(0.3, Math.min(3.0, natural));
  const speedExpr = `setpts=${(1 / speed).toFixed(4)}*PTS`;

  const zoomTarget = computeZoomTarget(ev.bbox, ev.importance);
  const zoomFilter = buildZoomFilter(zoomTarget, segDur);
  const c = colorFor(ev);

  const parts: string[] = [];
  parts.push(
    `[0:v]trim=start=${sliceStartS.toFixed(3)}:duration=${sliceDurS.toFixed(3)},setpts=PTS-STARTPTS,${speedExpr},fps=${FPS},format=yuv420p,trim=duration=${segDur.toFixed(3)},setpts=PTS-STARTPTS[v0]`,
  );
  // Apply zoom via crop filter, then scale up so crop=viewport case is identity.
  parts.push(zoomFilter);
  // Lay the zoomed viewport into the centered band, with a blurred cover behind.
  parts.push(
    `[zoomed]split=2[src1][src2]`,
    `[src1]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=24:1,eq=brightness=-0.2:saturation=0.55[bg]`,
    `[src2]scale=${INNER_W}:-2:flags=lanczos[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
  );

  // Outline / dramatic frame
  if (ev.outcome === "failure") {
    parts.push(`[base]drawbox=x=30:y=30:w=${OUT_W - 60}:h=${OUT_H - 60}:color=red@0.9:t=14[base2]`);
  } else if (ev.importance === "critical") {
    parts.push(`[base]drawbox=x=30:y=30:w=${OUT_W - 60}:h=${OUT_H - 60}:color=0xffd04a@0.7:t=10[base2]`);
  } else if (ev.importance === "high") {
    parts.push(`[base]drawbox=x=30:y=30:w=${OUT_W - 60}:h=${OUT_H - 60}:color=0x00e5a0@0.6:t=6[base2]`);
  } else {
    parts.push(`[base]null[base2]`);
  }

  const files = {
    heading: path.join(textDir, `${idx}-head.txt`),
    caption: path.join(textDir, `${idx}-cap.txt`),
    meta: path.join(textDir, `${idx}-meta.txt`),
  };
  await writeFile(files.heading, narration.heading);
  await writeFile(files.caption, wrapCaption(narration.caption, 26));
  const metaText = ev.error ? wrapCaption(`! ${ev.error}`, 34) : ev.notes ? wrapCaption(ev.notes, 34) : "";
  let lastNode = "base2";
  if (font) {
    const fontOpt = `fontfile=${ffEscapePath(font)}`;
    // Top chip
    parts.push(
      `[${lastNode}]drawbox=x=0:y=70:w=${OUT_W}:h=130:color=${c.primary}@0.95:t=fill[h1]`,
      `[h1]drawtext=${fontOpt}:textfile=${ffEscapePath(files.heading)}:fontcolor=${c.accent}:fontsize=52:x=(w-text_w)/2:y=105[h2]`,
    );
    lastNode = "h2";
    // Bottom caption slab — taller, with soft shadow
    parts.push(
      `[${lastNode}]drawbox=x=0:y=${OUT_H - 540}:w=${OUT_W}:h=460:color=0x0a0a0a@0.78:t=fill[c1]`,
      `[c1]drawtext=${fontOpt}:textfile=${ffEscapePath(files.caption)}:fontcolor=white:fontsize=78:x=(w-text_w)/2:y=${OUT_H - 500}:line_spacing=14:borderw=4:bordercolor=0x000000[c2]`,
    );
    lastNode = "c2";
    if (metaText) {
      await writeFile(files.meta, metaText);
      const color = ev.outcome === "failure" ? "0xff8888" : "0xa0ffcd";
      parts.push(
        `[${lastNode}]drawtext=${fontOpt}:textfile=${ffEscapePath(files.meta)}:fontcolor=${color}:fontsize=40:x=(w-text_w)/2:y=${OUT_H - 160}:line_spacing=6:borderw=2:bordercolor=0x000000[out]`,
      );
      lastNode = "out";
    }
  }
  if (lastNode !== "out") parts.push(`[${lastNode}]null[out]`);

  const finalArgs: string[] = ["-i", raw];
  const hasVoice = !!(voice && voiceDur > 0);
  let voiceIdx = -1;
  if (hasVoice) {
    voiceIdx = 1;
    finalArgs.push("-i", voicePath);
  }
  const silentIdx = hasVoice ? 2 : 1;
  finalArgs.push("-f", "lavfi", "-t", segDur.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");

  const audioParts: string[] = [];
  if (hasVoice) {
    audioParts.push(
      `[${voiceIdx}:a]adelay=200|200,apad=whole_dur=${segDur.toFixed(3)},volume=1.15[vox]`,
      `[${silentIdx}:a][vox]amix=inputs=2:duration=longest:dropout_transition=0,atrim=duration=${segDur.toFixed(3)}[aout]`,
    );
  } else {
    audioParts.push(`[${silentIdx}:a]atrim=duration=${segDur.toFixed(3)}[aout]`);
  }
  const combined = [...parts, ...audioParts].join(";");
  finalArgs.push("-filter_complex", combined);
  finalArgs.push(
    "-map", "[out]",
    "-map", "[aout]",
    "-t", segDur.toFixed(3),
    "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    outFile,
  );
  await runFfmpeg(finalArgs);
  return { file: outFile, durationS: segDur };
}

/**
 * Ken-burns zoom via zoompan. Output size locked to viewport so downstream composition is stable.
 */
function buildZoomFilter(target: ReturnType<typeof computeZoomTarget>, segDur: number): string {
  if (!target) return `[v0]null[zoomed]`;
  const { cx, cy, vw, vh, targetZ } = target;
  // Ease in over 55% of the segment; hold after.
  const holdFrame = Math.max(1, Math.round(FPS * segDur * 0.55));
  const zExpr = `if(lt(on,${holdFrame}),1+(${(targetZ - 1).toFixed(4)})*(on/${holdFrame}),${targetZ.toFixed(4)})`;
  const xExpr = `'${cx.toFixed(2)}-iw/zoom/2'`;
  const yExpr = `'${cy.toFixed(2)}-ih/zoom/2'`;
  return `[v0]zoompan=z='${zExpr}':x=${xExpr}:y=${yExpr}:d=1:s=${vw}x${vh}:fps=${FPS}[zoomed]`;
}

async function renderTitleCard(outFile: string, title: string, subtitle: string, font: string | null, textDir: string, voice: string | null): Promise<void> {
  const parts: string[] = [
    `color=c=0x0f1218:s=${OUT_W}x${OUT_H}:d=3.0:r=${FPS}[bg]`,
  ];
  const files = {
    brand: path.join(textDir, "title-brand.txt"),
    title: path.join(textDir, "title-main.txt"),
    sub: path.join(textDir, "title-sub.txt"),
  };
  await writeFile(files.brand, "tik-test");
  await writeFile(files.title, wrapCaption(title, 18));
  await writeFile(files.sub, wrapCaption(subtitle, 26));

  if (font) {
    const fontOpt = `fontfile=${ffEscapePath(font)}`;
    parts.push(
      `[bg]drawtext=${fontOpt}:textfile=${ffEscapePath(files.brand)}:fontcolor=0x00e5a0:fontsize=84:x=(w-text_w)/2:y=${OUT_H / 2 - 420}[t1]`,
      `[t1]drawtext=${fontOpt}:textfile=${ffEscapePath(files.title)}:fontcolor=white:fontsize=120:x=(w-text_w)/2:y=${OUT_H / 2 - 280}:line_spacing=18:borderw=4:bordercolor=0x000000[t2]`,
      `[t2]drawtext=${fontOpt}:textfile=${ffEscapePath(files.sub)}:fontcolor=0xb0b8c4:fontsize=52:x=(w-text_w)/2:y=${OUT_H / 2 + 120}:line_spacing=12[out]`,
    );
  } else {
    parts.push(`[bg]null[out]`);
  }

  // Voice-over for intro
  let vPath = "";
  let vDur = 0;
  if (voice) {
    vPath = path.join(textDir, "title-voice.aiff");
    try {
      await runSay(sanitiseForSpeech(`Tik-test. ${title}. ${subtitle}`), vPath, voice);
      vDur = await ffprobeDuration(vPath);
    } catch { vDur = 0; }
  }
  const dur = Math.max(3.0, vDur + 0.6);

  const args: string[] = ["-f", "lavfi", "-i", `color=c=black:s=16x16:d=${dur.toFixed(2)}:r=${FPS}`];
  if (voice && vDur > 0) args.push("-i", vPath);
  // Always add silent audio input so we have a guaranteed audio stream
  args.push("-f", "lavfi", "-t", dur.toFixed(2), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  const silentIdx = voice && vDur > 0 ? 2 : 1;
  const voiceIdx = 1;
  const audioParts: string[] = [];
  if (voice && vDur > 0) {
    audioParts.push(
      `[${voiceIdx}:a]adelay=150|150,apad=whole_dur=${dur.toFixed(2)}[vox]`,
      `[${silentIdx}:a][vox]amix=inputs=2:duration=longest,atrim=duration=${dur.toFixed(2)}[aout]`,
    );
  } else {
    audioParts.push(`[${silentIdx}:a]atrim=duration=${dur.toFixed(2)}[aout]`);
  }
  args.push("-filter_complex", [...parts, ...audioParts].join(";"));
  args.push(
    "-map", "[out]", "-map", "[aout]",
    "-t", dur.toFixed(2), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    outFile,
  );
  await runFfmpeg(args);
}

async function renderSummaryCard(outFile: string, artifacts: RunArtifacts, font: string | null, textDir: string, voice: string | null): Promise<void> {
  const total = artifacts.events.length;
  const passed = artifacts.events.filter((e) => e.outcome === "success").length;
  const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
  const skipped = artifacts.events.filter((e) => e.outcome === "skipped").length;
  const status = failed > 0 ? "ISSUES FOUND" : "ALL GREEN";
  const color = failed > 0 ? "0xff5d5d" : "0x00e5a0";

  const files = {
    status: path.join(textDir, "sum-status.txt"),
    name: path.join(textDir, "sum-name.txt"),
    counts: path.join(textDir, "sum-counts.txt"),
    dur: path.join(textDir, "sum-dur.txt"),
    cta: path.join(textDir, "sum-cta.txt"),
  };
  await writeFile(files.status, status);
  await writeFile(files.name, wrapCaption(artifacts.plan.name, 22));
  await writeFile(files.counts, `${passed}/${total} passed · ${failed} failed · ${skipped} skipped`);
  await writeFile(files.dur, `${(artifacts.totalMs / 1000).toFixed(1)}s total runtime`);
  await writeFile(files.cta, "Open the viewer to send\nfeedback to Claude");

  const parts = [
    `color=c=0x0f1218:s=${OUT_W}x${OUT_H}:d=4.0:r=${FPS}[bg]`,
  ];
  if (font) {
    const fontOpt = `fontfile=${ffEscapePath(font)}`;
    parts.push(
      `[bg]drawbox=x=60:y=260:w=${OUT_W - 120}:h=180:color=${color}:t=fill[h]`,
      `[h]drawtext=${fontOpt}:textfile=${ffEscapePath(files.status)}:fontcolor=0x0a0a0a:fontsize=92:x=(w-text_w)/2:y=300[h2]`,
      `[h2]drawtext=${fontOpt}:textfile=${ffEscapePath(files.name)}:fontcolor=white:fontsize=80:x=(w-text_w)/2:y=560:line_spacing=14:borderw=4:bordercolor=0x000000[h3]`,
      `[h3]drawtext=${fontOpt}:textfile=${ffEscapePath(files.counts)}:fontcolor=0xcccccc:fontsize=48:x=(w-text_w)/2:y=${OUT_H / 2 + 80}[h4]`,
      `[h4]drawtext=${fontOpt}:textfile=${ffEscapePath(files.dur)}:fontcolor=0x888888:fontsize=40:x=(w-text_w)/2:y=${OUT_H / 2 + 160}[h5]`,
      `[h5]drawtext=${fontOpt}:textfile=${ffEscapePath(files.cta)}:fontcolor=0x00e5a0:fontsize=48:x=(w-text_w)/2:y=${OUT_H - 360}:line_spacing=12[out]`,
    );
  } else {
    parts.push(`[bg]null[out]`);
  }

  let vPath = "";
  let vDur = 0;
  if (voice) {
    vPath = path.join(textDir, "sum-voice.aiff");
    const line = failed > 0
      ? `Heads up — ${failed} step${failed === 1 ? "" : "s"} failed. ${passed} out of ${total} passed. Review in the viewer and send feedback to Claude.`
      : `All ${total} steps passed. ${artifacts.plan.name} is looking good.`;
    try { await runSay(sanitiseForSpeech(line), vPath, voice); vDur = await ffprobeDuration(vPath); } catch {}
  }
  const dur = Math.max(4.0, vDur + 0.8);

  const args: string[] = ["-f", "lavfi", "-i", `color=c=black:s=16x16:d=${dur.toFixed(2)}:r=${FPS}`];
  if (voice && vDur > 0) args.push("-i", vPath);
  args.push("-f", "lavfi", "-t", dur.toFixed(2), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  const silentIdx = voice && vDur > 0 ? 2 : 1;
  const voiceIdx = 1;
  const audioParts: string[] = [];
  if (voice && vDur > 0) {
    audioParts.push(
      `[${voiceIdx}:a]adelay=250|250,apad=whole_dur=${dur.toFixed(2)}[vox]`,
      `[${silentIdx}:a][vox]amix=inputs=2:duration=longest,atrim=duration=${dur.toFixed(2)}[aout]`,
    );
  } else {
    audioParts.push(`[${silentIdx}:a]atrim=duration=${dur.toFixed(2)}[aout]`);
  }
  args.push("-filter_complex", [...parts, ...audioParts].join(";"));
  args.push(
    "-map", "[out]", "-map", "[aout]",
    "-t", dur.toFixed(2), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    outFile,
  );
  await runFfmpeg(args);
}

export interface EditOptions {
  artifacts: RunArtifacts;
  outPath: string;
  musicPath?: string;
  voice?: string | null; // macOS `say` voice name, null/undefined → no narration
}

export async function editHighlightReel({ artifacts, outPath, musicPath, voice = "Samantha" }: EditOptions): Promise<string> {
  const tmp = path.join(artifacts.runDir, "segments");
  const textDir = path.join(tmp, "text");
  await mkdir(tmp, { recursive: true });
  await mkdir(textDir, { recursive: true });
  const font = await findFont();
  if (!font) console.log(chalk.yellow("  warning: no bold font found, captions will be plain"));
  if (voice === null || voice === undefined || voice === "") {
    console.log(chalk.dim("  voice-over disabled"));
    voice = null as any;
  } else {
    console.log(chalk.dim(`  voice-over: ${voice}`));
  }

  const rawDuration = await ffprobeDuration(artifacts.rawVideoPath);
  const stepById = new Map<string, PlanStep>(artifacts.plan.steps.map((s) => [s.id, s]));

  console.log(chalk.dim(`  rendering ${artifacts.events.length} segments (with zoom, narration, captions)…`));
  const segPaths: string[] = [];

  const titlePath = path.join(tmp, "00-title.mp4");
  await renderTitleCard(titlePath, artifacts.plan.name, artifacts.plan.summary || artifacts.plan.startUrl, font, textDir, voice as string | null);
  segPaths.push(titlePath);

  for (let i = 0; i < artifacts.events.length; i++) {
    const ev = artifacts.events[i];
    const next = artifacts.events[i + 1];
    const MIN_SLICE = 0.6;
    let sliceStartS = ev.startMs / 1000;
    const rawEndS = next ? next.startMs / 1000 : rawDuration;
    let sliceDurS = Math.min(rawEndS - sliceStartS, rawDuration - sliceStartS - 0.02);
    if (sliceDurS < MIN_SLICE) {
      // Back up the start so we have enough video to render. Never negative.
      sliceStartS = Math.max(0, Math.min(sliceStartS, rawDuration - MIN_SLICE - 0.02));
      sliceDurS = Math.min(rawDuration - sliceStartS - 0.02, MIN_SLICE);
    }
    if (sliceDurS < 0.2) {
      // Completely out of runway — fall back to the last MIN_SLICE of the raw video.
      sliceStartS = Math.max(0, rawDuration - MIN_SLICE - 0.02);
      sliceDurS = MIN_SLICE;
    }
    const p = path.join(tmp, `seg-${String(i).padStart(3, "0")}.mp4`);
    try {
      const { file } = await renderSegment(
        artifacts.rawVideoPath,
        rawDuration,
        {
          ev,
          idx: i,
          total: artifacts.events.length,
          step: stepById.get(ev.stepId),
          planStartUrl: artifacts.plan.startUrl,
          sliceStartS,
          sliceDurS,
        },
        p,
        font,
        textDir,
        voice as string | null,
      );
      segPaths.push(file);
      process.stdout.write(chalk.dim(`    • segment ${i + 1}/${artifacts.events.length}\r`));
    } catch (e) {
      console.log(chalk.yellow(`\n  warning: segment ${i} (${ev.stepId}) failed: ${(e as Error).message.split("\n")[0]}`));
    }
  }
  process.stdout.write("\n");

  const summaryPath = path.join(tmp, "99-summary.mp4");
  await renderSummaryCard(summaryPath, artifacts, font, textDir, voice as string | null);
  segPaths.push(summaryPath);

  // Concat with audio + video: use concat filter to handle differing input durations cleanly.
  const concatOut = path.join(tmp, "concat.mp4");
  const inputsArgs = segPaths.flatMap((p) => ["-i", p]);
  const filterLabels = segPaths.map((_, i) => `[${i}:v][${i}:a]`).join("");
  const filter = `${filterLabels}concat=n=${segPaths.length}:v=1:a=1[v][a]`;
  await runFfmpeg([
    ...inputsArgs,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k",
    concatOut,
  ]);

  const totalDur = await ffprobeDuration(concatOut);

  if (musicPath) {
    await runFfmpeg([
      "-i", concatOut,
      "-stream_loop", "-1", "-i", musicPath,
      "-filter_complex", `[0:a]volume=1.0[voice];[1:a]volume=0.12,afade=t=out:st=${Math.max(0, totalDur - 1.5).toFixed(2)}:d=1.5[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`,
      "-map", "0:v", "-map", "[a]",
      "-t", totalDur.toFixed(2),
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-shortest",
      outPath,
    ]);
  } else {
    await runFfmpeg([
      "-i", concatOut,
      "-c", "copy",
      "-movflags", "+faststart",
      outPath,
    ]);
  }

  if (!process.env.TIK_KEEP_SEGMENTS) {
    await rm(tmp, { recursive: true, force: true });
  }
  return outPath;
}
