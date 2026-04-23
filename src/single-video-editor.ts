import { mkdir, writeFile, rm, stat } from "node:fs/promises";
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

const FPS = 30;

export interface SingleVideoEvent {
  index: number;
  kind: string;
  importance: "low" | "normal" | "high" | "critical";
  outcome: "success" | "failure" | "skipped";
  description: string;

  // Timeline in the trimmed master video (seconds)
  startS: number;
  endS: number;

  // Voice-over (plays during the event's window)
  caption: string;
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;

  // For pan/zoom + click flash
  targetX?: number;
  targetY?: number;
  clickAtS?: number;
}

export interface SingleVideoInput {
  title: string;
  summary: string;
  masterVideoSrc: string;   // path relative to publicDir
  viewport: { width: number; height: number };
  masterDurS: number;
  events: SingleVideoEvent[];

  introDurFrames: number;
  outroDurFrames: number;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  introVoiceSrc?: string;
  introVoiceDurS?: number;
  outroVoiceSrc?: string;
  outroVoiceDurS?: number;
}

function sanitiseForSpeech(s: string): string {
  return s.replace(/[✓✗⚠✨📸🎬]/g, "").replace(/—/g, "—").replace(/·/g, " ").replace(/\s+/g, " ").trim();
}

function bboxCenter(b?: BBox): { x: number; y: number } | undefined {
  if (!b) return undefined;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export interface SingleVideoEditOptions {
  artifacts: RunArtifacts;
  outPath: string;
  voice?: string | null;
  quick?: boolean;
  prTitle?: string;
  prBody?: string;
  focus?: string;
}

/**
 * Build a trimmed master video from the raw recording by collapsing long idle
 * stretches. Returns the mapping from original → trimmed timestamps.
 */
interface TrimSegment {
  rawStartS: number;
  rawEndS: number;
  speed: number;          // playback rate for this segment (>1 means fast-forward)
  trimmedStartS: number;
  trimmedEndS: number;
}

interface ActiveWindow { start: number; end: number }

function buildTrimPlan(
  rawDurS: number,
  windows: ActiveWindow[],
  idleThresholdS = 1.0,
  idleSpeed = 5.0,
): TrimSegment[] {
  if (windows.length === 0) return [{ rawStartS: 0, rawEndS: rawDurS, speed: 1.0, trimmedStartS: 0, trimmedEndS: rawDurS }];
  const segments: TrimSegment[] = [];
  const active: ActiveWindow[] = windows.map((w) => ({
    start: Math.max(0, w.start),
    end: Math.min(rawDurS, w.end),
  }));
  // Merge overlapping/adjacent active windows.
  active.sort((a, b) => a.start - b.start);
  const merged: typeof active = [];
  for (const w of active) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 0.05) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }

  let cursor = 0;
  let trimmedCursor = 0;
  for (const w of merged) {
    const idleBefore = w.start - cursor;
    if (idleBefore > idleThresholdS) {
      // Compress idle to idleThresholdS at natural speed OR speed-it-up to a cap of 0.5s trimmed.
      const idleTrimmedDurS = Math.min(idleBefore / idleSpeed, 0.6);
      const speed = idleBefore / Math.max(0.01, idleTrimmedDurS);
      segments.push({
        rawStartS: cursor,
        rawEndS: w.start,
        speed,
        trimmedStartS: trimmedCursor,
        trimmedEndS: trimmedCursor + idleTrimmedDurS,
      });
      trimmedCursor += idleTrimmedDurS;
    } else if (idleBefore > 0) {
      // Short idle: keep at natural speed.
      segments.push({
        rawStartS: cursor,
        rawEndS: w.start,
        speed: 1.0,
        trimmedStartS: trimmedCursor,
        trimmedEndS: trimmedCursor + idleBefore,
      });
      trimmedCursor += idleBefore;
    }
    const activeDurS = w.end - w.start;
    segments.push({
      rawStartS: w.start,
      rawEndS: w.end,
      speed: 1.0,
      trimmedStartS: trimmedCursor,
      trimmedEndS: trimmedCursor + activeDurS,
    });
    trimmedCursor += activeDurS;
    cursor = w.end;
  }
  // Tail after the last event — trim aggressively.
  if (cursor < rawDurS) {
    const tailDur = rawDurS - cursor;
    if (tailDur > idleThresholdS) {
      const trimmedTail = Math.min(0.4, tailDur / idleSpeed);
      segments.push({
        rawStartS: cursor,
        rawEndS: rawDurS,
        speed: tailDur / Math.max(0.01, trimmedTail),
        trimmedStartS: trimmedCursor,
        trimmedEndS: trimmedCursor + trimmedTail,
      });
    } else {
      segments.push({
        rawStartS: cursor,
        rawEndS: rawDurS,
        speed: 1.0,
        trimmedStartS: trimmedCursor,
        trimmedEndS: trimmedCursor + tailDur,
      });
    }
  }
  return segments;
}

function rawToTrimmed(rawS: number, plan: TrimSegment[]): number {
  for (const seg of plan) {
    if (rawS >= seg.rawStartS && rawS <= seg.rawEndS + 1e-6) {
      const localRaw = rawS - seg.rawStartS;
      const localTrimmed = localRaw / seg.speed;
      return seg.trimmedStartS + localTrimmed;
    }
  }
  // Fallback: clamp to last segment
  const last = plan[plan.length - 1];
  return last ? last.trimmedEndS : rawS;
}

/** Apply the trim plan to produce a single continuous MP4. */
async function renderTrimmedMaster(rawMp4: string, outMp4: string, plan: TrimSegment[]): Promise<void> {
  // Build a filter_complex that trims + setpts for each segment and concats.
  const videoParts: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i];
    const trimDur = s.rawEndS - s.rawStartS;
    if (trimDur <= 0.001) continue;
    videoParts.push(
      `[0:v]trim=start=${s.rawStartS.toFixed(3)}:duration=${trimDur.toFixed(3)},setpts=${(1 / s.speed).toFixed(4)}*(PTS-STARTPTS)[v${i}]`,
    );
    concatInputs.push(`[v${i}]`);
  }
  const filter = `${videoParts.join(";")};${concatInputs.join("")}concat=n=${concatInputs.length}:v=1:a=0[out]`;
  await runFfmpeg([
    "-i", rawMp4,
    "-filter_complex", filter,
    "-map", "[out]",
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

export async function editSingleVideo({
  artifacts, outPath, voice = "Samantha", quick = false,
  prTitle, prBody, focus,
}: SingleVideoEditOptions): Promise<string> {
  const runDir = artifacts.runDir;
  const publicDir = path.join(runDir, "public");
  await mkdir(publicDir, { recursive: true });

  // 1. Stage raw → MP4 for consistent frame rate.
  const stagedRaw = path.join(runDir, "raw.mp4");
  await runFfmpeg([
    "-i", artifacts.rawVideoPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-r", String(FPS), "-pix_fmt", "yuv420p", "-an",
    stagedRaw,
  ]);
  const rawDurS = await ffprobeDuration(stagedRaw);
  console.log(chalk.dim(`  raw: ${rawDurS.toFixed(1)}s @ ${artifacts.plan.viewport?.width ?? 1280}×${artifacts.plan.viewport?.height ?? 800}`));

  const stepsMap = new Map<string, PlanStep>(artifacts.plan.steps.map((s) => [s.id, s]));
  const viewport = artifacts.plan.viewport ?? { width: 1280, height: 800 };
  // Seed voice variation from the plan name (so two renders of the same PR
  // keep the same voice, but different PRs alternate across the feed).
  const ttsBackend: TTSBackend = resolveBackend(voice, artifacts.plan.name);
  console.log(chalk.dim(`  voice-over: ${describeBackend(ttsBackend)}`));

  // 2. Visible events.
  const BORING_KINDS = new Set(["script", "wait"]);
  const visibleEvents = artifacts.events.filter((e) => !BORING_KINDS.has(e.kind));

  // 3. Ask Claude for story narration UP FRONT so we know what each event's voice line is.
  let story: StoryOutput | null = null;
  if (prTitle || prBody || focus) {
    try {
      story = await generateStory({
        plan: artifacts.plan,
        events: artifacts.events,
        stepsById: stepsMap,
        prTitle, prBody, focus,
        visibleIndices: visibleEvents.map((ev) => artifacts.events.indexOf(ev)),
      });
    } catch (e) {
      console.log(chalk.yellow(`  story generation failed: ${(e as Error).message.split("\n")[0]}`));
    }
  }

  // 4. Generate voice-over for every event up front so we know exact voice durations.
  interface PreEvent {
    ev: StepEvent;
    voiceLine: string;
    caption: string;
    voiceSrc?: string;
    voiceDurS: number;
  }
  const preEvents: PreEvent[] = [];
  for (let i = 0; i < visibleEvents.length; i++) {
    const ev = visibleEvents[i];
    const step = stepsMap.get(ev.stepId) ?? ({} as PlanStep);
    const tpl = narrate({
      step: { ...step, id: ev.stepId, kind: ev.kind, description: ev.description, importance: ev.importance } as PlanStep,
      outcome: ev.outcome, error: ev.error, notes: ev.notes,
      index: i, total: visibleEvents.length, startUrl: artifacts.plan.startUrl,
    });
    const storied = story?.steps[i];
    const voiceLine = (storied?.voiceLine || tpl.voiceLine).trim();
    const caption = (storied?.captionText || tpl.captionText).trim();
    let voiceSrc: string | undefined;
    let voiceDurS = 0;
    if (ttsBackend) {
      const fileName = `voice-${String(i).padStart(3, "0")}.wav`;
      try {
        await synth(ttsBackend, sanitiseForSpeech(voiceLine), path.join(publicDir, fileName));
        voiceDurS = await ffprobeDuration(path.join(publicDir, fileName));
        voiceSrc = fileName;
      } catch (e) {
        console.log(chalk.yellow(`  voice skipped for step ${i}: ${(e as Error).message.split("\n")[0]}`));
      }
    }
    preEvents.push({ ev, voiceLine, caption, voiceSrc, voiceDurS });
  }

  // 5. Compute each event's raw-video active window — at least long enough for the voice line.
  // The window starts where the event begins (minus a 0.1s lead-in) and ends at max(natural end, start + voice + 0.25 tail).
  // Overlapping windows get merged so each event's audio has exclusive runway.
  const rawWindows: ActiveWindow[] = [];
  const preferredWindows: Array<{ start: number; end: number; voiceDurS: number }> = [];
  for (let i = 0; i < preEvents.length; i++) {
    const { ev, voiceDurS } = preEvents[i];
    const naturalStart = Math.max(0, ev.startMs / 1000 - 0.1);
    const naturalEnd = Math.min(rawDurS, ev.endMs / 1000 + 0.25);
    const voiceEnd = Math.min(rawDurS, naturalStart + voiceDurS + 0.25);
    preferredWindows.push({ start: naturalStart, end: Math.max(naturalEnd, voiceEnd), voiceDurS });
  }
  // Sort + merge adjacent/overlapping windows but REMEMBER the boundaries of each event inside merged groups.
  // We want each event to claim a non-overlapping span: if i's end > i+1's start, push i's end to exactly i+1's start.
  for (let i = 0; i < preferredWindows.length; i++) {
    const w = preferredWindows[i];
    const next = preferredWindows[i + 1];
    if (next && w.end > next.start) w.end = Math.max(w.start + 0.4, next.start);
    rawWindows.push({ start: w.start, end: w.end });
  }

  // 6. Build trim plan over those windows and render master.
  const plan = buildTrimPlan(rawDurS, rawWindows);
  const masterMp4Rel = "master.mp4";
  const masterMp4 = path.join(publicDir, masterMp4Rel);
  console.log(chalk.dim(`  trimming idle stretches (plan has ${plan.length} segments)…`));
  await renderTrimmedMaster(stagedRaw, masterMp4, plan);
  const masterDurS = await ffprobeDuration(masterMp4);
  console.log(chalk.dim(`  master: ${masterDurS.toFixed(1)}s (from ${rawDurS.toFixed(1)}s raw)`));

  // 7. Build final event list with timestamps remapped into the trimmed timeline.
  const sv: SingleVideoEvent[] = [];
  for (let i = 0; i < preEvents.length; i++) {
    const { ev, caption, voiceSrc, voiceDurS } = preEvents[i];
    const w = rawWindows[i];
    const startS = rawToTrimmed(w.start, plan);
    const endS = rawToTrimmed(w.end, plan);
    const windowDurS = Math.max(0.4, endS - startS);

    // Compute audio playbackRate so voice FITS its window. Small safety margin (0.08s)
    // prevents audio bleed into the next event's window.
    let voicePlaybackRate: number | undefined;
    if (voiceDurS > 0) {
      const maxAudioS = Math.max(0.4, windowDurS - 0.08);
      if (voiceDurS > maxAudioS) {
        voicePlaybackRate = Math.min(1.6, voiceDurS / maxAudioS);
      } else {
        voicePlaybackRate = 1.0;
      }
    }

    const center = bboxCenter(ev.bbox);
    const isClick = ev.kind === "click" || ev.kind === "fill" || ev.kind === "press" || ev.kind === "hover";
    const clickAtS = center && isClick
      ? rawToTrimmed(Math.min(w.end - 0.1, ev.startMs / 1000 + 0.7), plan)
      : undefined;
    sv.push({
      index: i,
      kind: ev.kind,
      importance: ev.importance,
      outcome: ev.outcome,
      description: ev.description,
      startS, endS,
      caption,
      voiceSrc, voiceDurS,
      voicePlaybackRate,
      targetX: center?.x,
      targetY: center?.y,
      clickAtS,
    });
  }

  // 6. Intro/outro narration.
  const passed = artifacts.events.filter((e) => e.outcome === "success").length;
  const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
  const skipped = artifacts.events.filter((e) => e.outcome === "skipped").length;
  const stats = { passed, failed, skipped, total: artifacts.events.length, durS: artifacts.totalMs / 1000 };

  const introLine = story?.intro ?? `Here's a walk-through of the ${artifacts.plan.name} change. Let me know what you think as I go.`;
  const outroLine = story?.outro ?? (failed > 0
    ? `${failed} step${failed === 1 ? "" : "s"} didn't behave as expected — curious if you see the same.`
    : `That's the flow — keen for your feedback on anything that feels off.`);
  let introVoiceSrc: string | undefined;
  let introVoiceDurS = 0;
  let outroVoiceSrc: string | undefined;
  let outroVoiceDurS = 0;
  if (ttsBackend) {
    try {
      await synth(ttsBackend, sanitiseForSpeech(introLine), path.join(publicDir, "intro.wav"));
      introVoiceDurS = await ffprobeDuration(path.join(publicDir, "intro.wav"));
      introVoiceSrc = "intro.wav";
    } catch {}
    try {
      await synth(ttsBackend, sanitiseForSpeech(outroLine), path.join(publicDir, "outro.wav"));
      outroVoiceDurS = await ffprobeDuration(path.join(publicDir, "outro.wav"));
      outroVoiceSrc = "outro.wav";
    } catch {}
  }

  const introDurFrames = Math.max(Math.round(FPS * 3.4), Math.round((introVoiceDurS + 0.6) * FPS));
  const outroDurFrames = Math.max(Math.round(FPS * 3.2), Math.round((outroVoiceDurS + 0.6) * FPS));

  const input: SingleVideoInput = {
    title: artifacts.plan.name || "Feature review",
    summary: artifacts.plan.summary || artifacts.plan.startUrl,
    masterVideoSrc: masterMp4Rel,
    viewport,
    masterDurS,
    events: sv,
    introDurFrames,
    outroDurFrames,
    stats,
    introVoiceSrc,
    introVoiceDurS: introVoiceDurS || undefined,
    outroVoiceSrc,
    outroVoiceDurS: outroVoiceDurS || undefined,
  };
  await writeFile(path.join(runDir, "reel-input.json"), JSON.stringify(input, null, 2));

  // 7. Bundle + render via Remotion.
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
    id: "SingleVideoReel",
    inputProps: input as any,
  });

  const concurrency = Math.max(2, Math.min(os.cpus().length, 12));
  const effectiveWidth = quick ? 540 : composition.width;
  const effectiveHeight = quick ? 960 : composition.height;
  console.log(chalk.dim(`  rendering ${composition.durationInFrames} frames (${(composition.durationInFrames / FPS).toFixed(1)}s) at ${effectiveWidth}×${effectiveHeight} with concurrency ${concurrency}…`));
  const renderStart = Date.now();
  let lastReportedPct = -1;
  await renderMedia({
    composition: { ...composition, width: effectiveWidth, height: effectiveHeight },
    serveUrl: bundleOutput,
    codec: "h264",
    outputLocation: outPath,
    inputProps: input as any,
    audioCodec: "aac",
    enforceAudioTrack: true,
    concurrency,
    jpegQuality: quick ? 70 : 88,
    // Explicit bitrate: Remotion's h264 defaults are middling on mobile at
    // 1080×1920. Bump to ~6 Mbps for the full-res render so text stays crisp
    // on phone screens. Quick mode keeps it lean so drafts render fast.
    videoBitrate: quick ? "1200k" : "6000k",
    audioBitrate: "160k",
    onProgress: ({ progress, renderedFrames, encodedFrames }) => {
      const pct = Math.floor(progress * 100);
      if (pct >= lastReportedPct + 2 || pct === 100) {
        const elapsed = (Date.now() - renderStart) / 1000;
        const fps = renderedFrames && elapsed > 0 ? (renderedFrames / elapsed).toFixed(1) : "—";
        const eta = pct > 0 ? Math.round(elapsed * (100 - pct) / pct) : undefined;
        console.log(chalk.dim(`    ${String(pct).padStart(3, " ")}%  rendered ${renderedFrames}/${composition.durationInFrames}  encoded ${encodedFrames}/${composition.durationInFrames}  ${fps} fps${eta != null ? ` · eta ${eta}s` : ""}`));
        lastReportedPct = pct;
      }
    },
    overwrite: true,
    logLevel: process.env.TIK_REMOTION_DEBUG ? "verbose" : "error",
  });

  if (!process.env.TIK_KEEP_PUBLIC) {
    await rm(publicDir, { recursive: true, force: true }).catch(() => {});
  }
  return outPath;
}

export async function renderPreviewGif(mp4Path: string, gifPath: string): Promise<void> {
  const probeDur = await ffprobeDuration(mp4Path);
  const speedMultiplier = probeDur > 26 ? probeDur / 22 : 1;
  const palettePath = gifPath.replace(/\.gif$/i, ".palette.png");
  const vf = `setpts=${(1 / speedMultiplier).toFixed(4)}*PTS,fps=10,scale=420:-2:flags=lanczos`;
  await runFfmpeg(["-i", mp4Path, "-vf", `${vf},palettegen=stats_mode=diff:max_colors=128`, "-y", palettePath]);
  await runFfmpeg(["-i", mp4Path, "-i", palettePath, "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=sierra2_4a`, "-y", gifPath]);
  await rm(palettePath, { force: true });
}
