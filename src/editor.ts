import { mkdir, writeFile, rm, stat, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { runFfmpeg, ffprobeDuration } from "./ffmpeg.js";
import { narrate } from "./narrator.js";
import { resolveBackend, describeBackend, synth, type TTSBackend } from "./tts.js";
import { generateStory, type StoryOutput } from "./story.js";
import type { RunArtifacts, StepEvent, PlanStep, BBox } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REMOTION_ENTRY = path.resolve(__dirname, "..", "remotion", "index.ts");

const FPS = 24;
// Clip canvas delivered to Remotion — we bake the zoom at this size so Remotion only
// has to composite, never re-scale. Choosing 540x960 keeps file sizes small for the
// default path; quick-mode uses these dimensions straight through.
const OUT_W_CLIP = 540;
const OUT_H_CLIP = 960;

interface ReelBBox {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number;
}
interface ReelStep {
  id: string;
  kind: string;
  importance: "low" | "normal" | "high" | "critical";
  outcome: "success" | "failure" | "skipped";
  description: string;
  caption: string;
  titleSlideLabel: string;
  titleSlideText: string;
  // Pre-sliced per-step clip served via staticFile
  clipSrc: string;
  clipDurS: number;         // duration of the sliced clip on disk
  playbackRate: number;     // how fast the clip plays in the composition
  stepDurFrames: number;
  introDurFrames: number;
  prevCursor?: { x: number; y: number };
  targetCursor?: { x: number; y: number };
  clickFrame?: number;
  isClick: boolean;
  bbox?: ReelBBox;
  voiceSrc?: string;
  voiceDurS?: number;
  error?: string;
}
interface ReelInput {
  title: string;
  summary: string;
  viewport: { width: number; height: number };
  steps: ReelStep[];
  introDurFrames: number;
  outroDurFrames: number;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  introVoiceSrc?: string;
  introVoiceDurS?: number;
  outroVoiceSrc?: string;
  outroVoiceDurS?: number;
}

function sanitiseForSpeech(s: string): string {
  return s
    .replace(/[✓✗⚠✨📸🎬]/g, "")
    .replace(/—/g, "—")
    .replace(/·/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bboxCenter(b?: BBox): { x: number; y: number } | undefined {
  if (!b) return undefined;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function toReelBBox(b?: BBox): ReelBBox | undefined {
  if (!b) return undefined;
  return {
    x: b.x, y: b.y, width: b.width, height: b.height,
    viewportWidth: b.viewportWidth, viewportHeight: b.viewportHeight,
  };
}

function isClickKind(k: string): boolean {
  return k === "click" || k === "fill" || k === "press" || k === "hover";
}

export interface EditOptions {
  artifacts: RunArtifacts;
  outPath: string;
  musicPath?: string;
  voice?: string | null;
  quick?: boolean;           // low-res/low-fps draft for iteration
  prTitle?: string;          // feeds into Claude-driven narration
  prBody?: string;
  focus?: string;
}

export async function editHighlightReel({
  artifacts, outPath,
  voice = "Samantha", musicPath, quick = false,
  prTitle, prBody, focus,
}: EditOptions): Promise<string> {
  const runDir = artifacts.runDir;
  const publicDir = path.join(runDir, "public");
  await mkdir(publicDir, { recursive: true });

  // 1. Transcode the raw webm into an MP4 we can slice per step (needed because
  //    ffmpeg can be fussy about seeking into a VP8/9 webm with variable framerates).
  const stagedRaw = path.join(runDir, "raw.mp4");
  await transcodeRawForRemotion(artifacts.rawVideoPath, stagedRaw);
  const rawDuration = await ffprobeDuration(stagedRaw);

  const stepsMap = new Map<string, PlanStep>(artifacts.plan.steps.map((s) => [s.id, s]));
  const viewport = artifacts.plan.viewport ?? { width: 1280, height: 800 };
  const ttsBackend: TTSBackend = resolveBackend(voice, artifacts.plan.name);
  const voiceEnabled = !!ttsBackend;
  console.log(chalk.dim(`  voice-over: ${describeBackend(ttsBackend)}`));

  // 2. Build per-step reel entries with cursor tracking + timing.
  // Boring plumbing steps (scripted dropdown tweaks, bare waits) are plumbing —
  // they belong in the test plan but not in the TikTok reel.
  const BORING_KINDS = new Set(["script", "wait"]);
  const MAX_BEATS = 9; // TikTok is short — pick at most this many beats.
  let visibleEvents = artifacts.events.filter((e) => !BORING_KINDS.has(e.kind));

  // If we still have too many beats, cut to a story-worthy shortlist.
  if (visibleEvents.length > MAX_BEATS) {
    const scored = visibleEvents.map((ev, idx) => {
      let score = 0;
      if (ev.outcome === "failure") score += 100;
      if (ev.importance === "critical") score += 50;
      if (ev.importance === "high") score += 30;
      if (ev.kind === "navigate") score += 25; // keep the opener
      if (ev.kind === "click") score += 8;
      if (ev.kind === "fill") score += 6;
      if (ev.kind === "assert-visible" || ev.kind === "assert-text") score += 4;
      // Always keep the first + last beat so the story has a cold open and a landing.
      if (idx === 0) score += 40;
      if (idx === visibleEvents.length - 1) score += 40;
      return { ev, idx, score };
    });
    const keep = new Set(
      scored
        .sort((a, b) => b.score - a.score || a.idx - b.idx)
        .slice(0, MAX_BEATS)
        .map((s) => s.idx),
    );
    visibleEvents = visibleEvents.filter((_, i) => keep.has(i));
  }
  const visibleIndices = visibleEvents.map((ev) => artifacts.events.indexOf(ev));

  // Ask Claude to author the story voice-over — falls back to local templates on error.
  let story: StoryOutput | null = null;
  if (prTitle || prBody || focus) {
    try {
      story = await generateStory({
        plan: artifacts.plan,
        events: artifacts.events,
        stepsById: stepsMap,
        prTitle,
        prBody,
        focus,
        visibleIndices,
      });
    } catch (e) {
      console.log(chalk.yellow(`  story generation failed: ${(e as Error).message.split("\n")[0]} — falling back to templates`));
    }
  }

  const reelSteps: ReelStep[] = [];
  let lastCursor: { x: number; y: number } | undefined;
  for (let i = 0; i < visibleEvents.length; i++) {
    const ev = visibleEvents[i];
    const step = stepsMap.get(ev.stepId) ?? ({} as PlanStep);
    const next = visibleEvents[i + 1];

    const tpl = narrate({
      step: { ...step, id: ev.stepId, kind: ev.kind, description: ev.description, importance: ev.importance } as PlanStep,
      outcome: ev.outcome,
      error: ev.error,
      notes: ev.notes,
      index: i,
      total: visibleEvents.length,
      startUrl: artifacts.plan.startUrl,
    });
    const storied = story?.steps[i];
    const narration = storied
      ? {
          voiceLine: storied.voiceLine || tpl.voiceLine,
          captionText: storied.captionText || tpl.captionText,
          titleSlideLabel: storied.titleSlideLabel || tpl.titleSlideLabel,
          titleSlideText: storied.titleSlideText || tpl.titleSlideText,
        }
      : tpl;

    // Voice-over per step
    let voiceSrc: string | undefined;
    let voiceDurS = 0;
    if (ttsBackend) {
      const voiceFile = `voice-${String(i).padStart(3, "0")}.wav`;
      const voicePath = path.join(publicDir, voiceFile);
      try {
        await synth(ttsBackend, sanitiseForSpeech(narration.voiceLine), voicePath);
        voiceDurS = await ffprobeDuration(voicePath);
        voiceSrc = voiceFile;
      } catch (e) {
        console.log(chalk.yellow(`  voice-over skipped for step ${i}: ${(e as Error).message.split("\n")[0]}`));
      }
    }

    // Source slice runs from this step's start to the next *visible* step's start
    // (so skipped boring steps fold their footage into the surrounding clip — not lost).
    const MIN_SLICE = 0.6;
    let sourceStartS = ev.startMs / 1000;
    let sourceEndS = next ? next.startMs / 1000 : rawDuration;
    let sourceDurS = Math.min(sourceEndS - sourceStartS, rawDuration - sourceStartS - 0.02);
    if (sourceDurS < MIN_SLICE) {
      sourceStartS = Math.max(0, Math.min(sourceStartS, rawDuration - MIN_SLICE - 0.02));
      sourceDurS = Math.min(rawDuration - sourceStartS - 0.02, MIN_SLICE);
    }
    if (sourceDurS < 0.3) {
      sourceStartS = Math.max(0, rawDuration - MIN_SLICE - 0.02);
      sourceDurS = MIN_SLICE;
    }

    // Step reel duration = max(minDwell, voiceDur+pad).
    // Voice is the source of truth — segment length = voice length + small tail.
    // Without voice we fall back to a sensible minimum per importance.
    const fallbackDwell =
      ev.outcome === "failure" ? 2.4 :
      ev.importance === "critical" ? 2.1 :
      ev.importance === "high" ? 1.7 :
      1.3;
    const stepDurS = voiceDurS > 0
      ? Math.max(1.0, voiceDurS + 0.35)
      : fallbackDwell;
    // Title cards only for the most important beats — most steps are card-less.
    const deservesTitleCard =
      ev.importance === "critical" ||
      ev.outcome === "failure";
    // Readable dwell: long enough to take in the whole headline + the spring-in animation.
    const introSlideDurS = !deservesTitleCard ? 0 : 1.75;
    const stepDurFrames = Math.round(stepDurS * FPS);
    const introDurFrames = Math.round(introSlideDurS * FPS);

    // Pre-slice + pad so the clip is EXACTLY stepDurS long — Remotion plays at 1x.
    const speedHint =
      ev.outcome === "failure" ? 0.6 :
      ev.importance === "critical" ? 0.75 :
      ev.importance === "high" ? 0.85 :
      ev.kind === "wait" ? 2.2 :
      1.0;
    const clipFile = `step-${String(i).padStart(3, "0")}.mp4`;
    const clipPath = path.join(publicDir, clipFile);
    // No lead-hold — the raw slice already contains a 700ms approach pause
    // (runner.ts adds waitForTimeout before each click/fill). The action fires
    // roughly 700ms into the slice, which is where we snap the zoom.
    const leadHoldS = 0;
    const CLICK_IN_CLIP_S = 0.8;  // approximate click time inside the slice
    const snapAtS = CLICK_IN_CLIP_S;
    // Zoom-out starts shortly after the snap settles, so the reveal lands
    // well before the segment ends and the viewer can read the UI response.
    const zoomOutAtS = Math.min(stepDurS - 0.9, snapAtS + 0.65);

    // Build the bake-in zoom spec if we know where to focus.
    const center = bboxCenter(ev.bbox);
    const zoom: ZoomSpec | null = center ? {
      outW: OUT_W_CLIP,
      outH: OUT_H_CLIP,
      viewport,
      targetX: center.x,
      targetY: center.y,
      wideZoom: 1.0,
      peakZoom:
        ev.outcome === "failure" ? 1.9 :
        ev.importance === "critical" ? 2.0 :
        ev.importance === "high" ? 1.7 :
        1.35,
      settleZoom:
        ev.outcome === "failure" ? 1.35 :
        ev.importance === "critical" ? 1.5 :
        ev.importance === "high" ? 1.3 :
        1.12,
      snapAtS,
      zoomOutAtS,
      blurSigma: 0,
    } : null;

    await sliceClip(stagedRaw, clipPath, {
      startS: sourceStartS,
      sourceDurS,
      segDurS: stepDurS,
      speedHint,
      leadHoldS,
      zoom,
    });
    const clipDurS = await ffprobeDuration(clipPath);
    const playbackRate = 1;

    // Click flash fires at the moment the real action happens in the clip.
    const clickFrame = center && isClickKind(ev.kind)
      ? Math.round(snapAtS * FPS)
      : undefined;

    reelSteps.push({
      id: ev.stepId,
      kind: ev.kind,
      importance: ev.importance,
      outcome: ev.outcome,
      description: ev.description,
      caption: narration.captionText,
      titleSlideLabel: narration.titleSlideLabel,
      titleSlideText: narration.titleSlideText,
      clipSrc: clipFile,
      clipDurS,
      playbackRate,
      stepDurFrames,
      introDurFrames,
      prevCursor: center ? lastCursor : undefined,
      targetCursor: center,
      clickFrame,
      isClick: !!center && isClickKind(ev.kind),
      bbox: toReelBBox(ev.bbox),
      voiceSrc,
      voiceDurS,
      error: ev.error,
    });
    if (center) lastCursor = center;
  }

  // 3. Intro + outro voice
  const passed = artifacts.events.filter((e) => e.outcome === "success").length;
  const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
  const skipped = artifacts.events.filter((e) => e.outcome === "skipped").length;
  const stats = { passed, failed, skipped, total: artifacts.events.length, durS: artifacts.totalMs / 1000 };

  let introVoiceSrc: string | undefined;
  let introVoiceDurS = 0;
  let outroVoiceSrc: string | undefined;
  let outroVoiceDurS = 0;
  const introLine = story?.intro ??
    `Alright, here's a new build of ${artifacts.plan.name}. Let me walk you through what changed.`;
  const outroLine = story?.outro ?? (failed > 0
    ? `${failed} step${failed === 1 ? "" : "s"} failed. ${passed} out of ${artifacts.events.length} passed. Check the flagged beats above.`
    : `All ${artifacts.events.length} steps passed. This build is looking good.`);
  if (ttsBackend) {
    try {
      const introVoice = "intro.wav";
      await synth(ttsBackend, sanitiseForSpeech(introLine), path.join(publicDir, introVoice));
      introVoiceDurS = await ffprobeDuration(path.join(publicDir, introVoice));
      introVoiceSrc = introVoice;
    } catch {}
    try {
      const outroVoice = "outro.wav";
      await synth(ttsBackend, sanitiseForSpeech(outroLine), path.join(publicDir, outroVoice));
      outroVoiceDurS = await ffprobeDuration(path.join(publicDir, outroVoice));
      outroVoiceSrc = outroVoice;
    } catch {}
  }

  // Intro + outro get real dwell so the viewer can actually read them.
  const introDurFrames = Math.max(Math.round(FPS * 4.2), Math.round((introVoiceDurS + 1.0) * FPS));
  const outroDurFrames = Math.max(Math.round(FPS * 4.5), Math.round((outroVoiceDurS + 1.0) * FPS));

  const input: ReelInput = {
    title: artifacts.plan.name || "Feature review",
    summary: artifacts.plan.summary || artifacts.plan.startUrl,
    viewport,
    steps: reelSteps,
    introDurFrames,
    outroDurFrames,
    stats,
    introVoiceSrc,
    introVoiceDurS: introVoiceDurS || undefined,
    outroVoiceSrc,
    outroVoiceDurS: outroVoiceDurS || undefined,
  };

  // 4. Bundle + render via Remotion.
  console.log(chalk.dim("  bundling remotion project…"));
  const bundleOutput = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir,
    onProgress: () => {},
    webpackOverride: (c) => c,
  });

  console.log(chalk.dim("  resolving composition…"));
  const composition = await selectComposition({
    serveUrl: bundleOutput,
    id: "VideoReel",
    inputProps: input as any,
  });

  const totalFrames = composition.durationInFrames;
  const totalS = (totalFrames / FPS).toFixed(1);
  const concurrency = Math.max(2, Math.min(os.cpus().length, 12));
  const effectiveWidth = quick ? 540 : composition.width;
  const effectiveHeight = quick ? 960 : composition.height;
  console.log(chalk.dim(`  rendering ${totalFrames} frames (${totalS}s) at ${effectiveWidth}×${effectiveHeight} with concurrency ${concurrency}…`));
  const renderStart = Date.now();
  let lastReportedPct = -1;
  await renderMedia({
    composition: {
      ...composition,
      width: effectiveWidth,
      height: effectiveHeight,
    },
    serveUrl: bundleOutput,
    codec: "h264",
    outputLocation: outPath,
    inputProps: input as any,
    audioCodec: "aac",
    enforceAudioTrack: true,
    concurrency,
    jpegQuality: quick ? 70 : 82,
    chromiumOptions: {
      gl: (process.env.TIK_REMOTION_GL as any)
        ?? (process.platform === "darwin" ? "angle" : "angle-egl"),
    },
    offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
    onProgress: ({ progress, renderedFrames, encodedFrames }) => {
      const pct = Math.floor(progress * 100);
      // Emit a full line every 2% (or when encodedFrames tick) so progress survives pipe buffering.
      if (pct >= lastReportedPct + 2 || pct === 100) {
        const elapsedS = (Date.now() - renderStart) / 1000;
        const fps = renderedFrames && elapsedS > 0 ? (renderedFrames / elapsedS).toFixed(1) : "—";
        const etaS = pct > 0 ? Math.round(elapsedS * (100 - pct) / pct) : undefined;
        const etaStr = etaS != null ? ` · eta ${etaS}s` : "";
        console.log(chalk.dim(
          `    ${String(pct).padStart(3, " ")}%  rendered ${renderedFrames ?? 0}/${totalFrames}  encoded ${encodedFrames ?? 0}/${totalFrames}  ${fps} fps${etaStr}`,
        ));
        lastReportedPct = pct;
      }
    },
    overwrite: true,
    logLevel: process.env.TIK_REMOTION_DEBUG ? "verbose" : "error",
  });

  // Optional background music mix as post-process
  if (musicPath) {
    const withMusic = outPath.replace(/\.mp4$/i, "-music.mp4");
    const dur = await ffprobeDuration(outPath);
    await runFfmpeg([
      "-i", outPath,
      "-stream_loop", "-1", "-i", musicPath,
      "-filter_complex", `[0:a]volume=1.0[voice];[1:a]volume=0.12,afade=t=out:st=${Math.max(0, dur - 1.5).toFixed(2)}:d=1.5[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`,
      "-map", "0:v", "-map", "[a]", "-t", dur.toFixed(2),
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-shortest",
      withMusic,
    ]);
    await rm(outPath, { force: true });
    const { rename } = await import("node:fs/promises");
    await rename(withMusic, outPath);
  }

  // Keep public/ for debug if requested
  if (!process.env.TIK_KEEP_PUBLIC) {
    await rm(publicDir, { recursive: true, force: true }).catch(() => {});
  }
  return outPath;
}

async function transcodeRawForRemotion(rawPath: string, outMp4: string): Promise<void> {
  await runFfmpeg([
    "-i", rawPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-r", String(FPS),
    "-pix_fmt", "yuv420p",
    "-an",
    outMp4,
  ]);
}

interface SliceOpts {
  startS: number;
  sourceDurS: number;   // raw slice length
  segDurS: number;      // desired output length in the reel (exact)
  speedHint: number;    // 1.0 = natural, <1 = slow-mo, >1 = speed up
  leadHoldS?: number;   // seconds of static first-frame at the very start (gives narration runway before the action)
  zoom?: ZoomSpec | null;
}

interface ZoomSpec {
  outW: number;
  outH: number;
  viewport: { width: number; height: number };
  targetX: number;     // element center, viewport coords
  targetY: number;
  peakZoom: number;    // how tight to go at the punch (during/just after click)
  settleZoom: number;  // tight hold right after the overshoot
  wideZoom: number;    // the "pulled-back" zoom used before the snap and after the zoom-out
  snapAtS: number;     // when in the clip the whoosh fires
  zoomOutAtS: number;  // when in the clip we ease back out to show UI reaction
  blurSigma: number;
}

/**
 * Produce an MP4 that is EXACTLY segDurS seconds long by:
 *   1. cutting the requested source slice,
 *   2. applying a speed factor (setpts) to scale action duration,
 *   3. padding the last frame (tpad) to reach segDurS.
 * This way the composition never sees black tail frames.
 */
async function sliceClip(sourceMp4: string, outMp4: string, opts: SliceOpts): Promise<void> {
  const startS = Math.max(0, opts.startS);
  const sourceDurS = Math.max(0.2, opts.sourceDurS);
  const segDurS = Math.max(0.4, opts.segDurS);
  const leadHoldS = Math.max(0, opts.leadHoldS ?? 0);

  const actionBudget = Math.max(0.3, segDurS - leadHoldS);
  const naturalSegFromSource = sourceDurS / opts.speedHint;
  let setptsFactor: number;
  let tailHoldS: number;
  if (naturalSegFromSource >= actionBudget) {
    setptsFactor = actionBudget / sourceDurS;
    tailHoldS = 0;
  } else {
    setptsFactor = 1 / opts.speedHint;
    tailHoldS = actionBudget - naturalSegFromSource;
  }
  const filters: string[] = [`setpts=${setptsFactor.toFixed(4)}*PTS`];
  if (leadHoldS > 0) filters.push(`tpad=start_mode=clone:start_duration=${leadHoldS.toFixed(3)}`);
  if (tailHoldS > 0) filters.push(`tpad=stop_mode=clone:stop_duration=${tailHoldS.toFixed(3)}`);
  filters.push(`fps=${FPS}`);

  // Bake the cinematic pan+zoom INTO the clip here so Remotion doesn't have to re-render it.
  if (opts.zoom) {
    filters.push(...zoomFilterChain(opts.zoom, segDurS));
  } else {
    filters.push(`scale=${OUT_W_CLIP}:${OUT_H_CLIP}:force_original_aspect_ratio=increase,crop=${OUT_W_CLIP}:${OUT_H_CLIP},setsar=1`);
  }

  await runFfmpeg([
    "-ss", startS.toFixed(3),
    "-t", sourceDurS.toFixed(3),
    "-i", sourceMp4,
    "-vf", filters.join(","),
    "-t", segDurS.toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-r", String(FPS),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    outMp4,
  ]);
}

/**
 * Build an ffmpeg filter chain that produces a beautiful pan+zoom+motion-blur effect
 * centred on the target element. Runs as a native filter graph — WAY faster than doing
 * per-frame CSS transforms inside a headless Chrome composition.
 *
 * Strategy: use scale + crop with time-varying x,y (element centroid) plus an animated
 * scale factor that eases from settleMin → peak → settle. A gblur burst fires around
 * the snap moment to simulate motion blur.
 */
function zoomFilterChain(z: ZoomSpec, segDurS: number): string[] {
  const { outW, outH, viewport, targetX, targetY, peakZoom, settleZoom, wideZoom, snapAtS, zoomOutAtS } = z;

  // Pre-scale so the viewport covers the output canvas (no black letterbox).
  const vw = viewport.width;
  const vh = viewport.height;
  const baseScale = Math.max(outW / vw, outH / vh);
  const canvasW = Math.max(outW, Math.ceil(vw * baseScale / 2) * 2);
  const canvasH = Math.max(outH, Math.ceil(vh * baseScale / 2) * 2);
  const tx = targetX * baseScale;
  const ty = targetY * baseScale;

  // Timing windows — all short & snappy so the motion feels kinetic.
  const snapLen = 0.14;                  // ramp-in to peak
  const overshootLen = 0.18;             // spring back to settleZoom
  const zoomOutLen = 0.35;               // ease back out to wideZoom to reveal reaction
  const snapEnd = snapAtS + snapLen;
  const overshootEnd = snapEnd + overshootLen;
  const zoomOutEnd = Math.min(segDurS - 0.05, zoomOutAtS + zoomOutLen);

  // Zoom value over time (5 phases):
  //   [0 .. snapAtS]               → wide (pre-click)
  //   [snapAtS .. snapEnd]         → snap in to peak
  //   [snapEnd .. overshootEnd]    → overshoot down to settle
  //   [overshootEnd .. zoomOutAtS] → hold on settle (click moment + immediate reaction)
  //   [zoomOutAtS .. zoomOutEnd]   → ease back out to wide (see result)
  //   [zoomOutEnd .. end]          → wide hold
  const lerp = (a: number, b: number, t0: string, t1: string, denom: string) =>
    `${a.toFixed(4)}+(${(b - a).toFixed(4)})*((ot-${t0})/${denom})`;
  const zExpr =
    `if(lt(ot,${snapAtS.toFixed(3)}),${wideZoom.toFixed(4)},` +
    `if(lt(ot,${snapEnd.toFixed(3)}),${lerp(wideZoom, peakZoom, snapAtS.toFixed(3), snapEnd.toFixed(3), snapLen.toFixed(3))},` +
    `if(lt(ot,${overshootEnd.toFixed(3)}),${lerp(peakZoom, settleZoom, snapEnd.toFixed(3), overshootEnd.toFixed(3), overshootLen.toFixed(3))},` +
    `if(lt(ot,${zoomOutAtS.toFixed(3)}),${settleZoom.toFixed(4)},` +
    `if(lt(ot,${zoomOutEnd.toFixed(3)}),${lerp(settleZoom, wideZoom, zoomOutAtS.toFixed(3), zoomOutEnd.toFixed(3), zoomOutLen.toFixed(3))},` +
    `${wideZoom.toFixed(4)})))))`;

  const xExpr = `${tx.toFixed(2)}-iw/zoom/2`;
  const yExpr = `${ty.toFixed(2)}-ih/zoom/2`;

  return [
    `scale=${canvasW}:${canvasH}:flags=lanczos`,
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${outW}x${outH}:fps=${FPS}`,
    "setsar=1",
  ];
  // NB: we deliberately dropped gblur — ffmpeg's `enable=between(...)` on gblur
  // leaves an unintended ghost on the last frame. The snap itself reads fine
  // without it; we can revisit once we confirm the sync pass works.
}

/**
 * Generate a compressed animated preview GIF that renders inline on GitHub.
 * Two-pass palettegen/paletteuse for small file size and clean colours.
 */
export async function renderPreviewGif(mp4Path: string, gifPath: string): Promise<void> {
  const probeDur = await ffprobeDuration(mp4Path);
  const speedMultiplier = probeDur > 26 ? probeDur / 22 : 1;
  const palettePath = gifPath.replace(/\.gif$/i, ".palette.png");
  const vf = `setpts=${(1 / speedMultiplier).toFixed(4)}*PTS,fps=10,scale=420:-2:flags=lanczos`;
  await runFfmpeg([
    "-i", mp4Path,
    "-vf", `${vf},palettegen=stats_mode=diff:max_colors=128`,
    "-y", palettePath,
  ]);
  await runFfmpeg([
    "-i", mp4Path,
    "-i", palettePath,
    "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=sierra2_4a`,
    "-y", gifPath,
  ]);
  await rm(palettePath, { force: true });
}
