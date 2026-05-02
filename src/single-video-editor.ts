import { mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { runFfmpeg, ffprobeDuration } from "./ffmpeg.js";
import { resolveBackend, describeBackend, synth, type TTSBackend } from "./tts.js";
import { generateNarration, type NarrationWindow } from "./timed-narration.js";
import { generateChecklist } from "./checklist.js";
import { clipToWord } from "./text.js";
import {
  MIN_CHUNK_S, MAX_BODY_SCENES, TRIM_MERGE_S,
  INTRO_TARGET_S, OUTRO_TARGET_S, OUTRO_HOLD_S,
  RENDER_SEGMENTS, OFFTHREAD_VIDEO_CACHE_MB,
} from "./timeouts.js";
import type { RunArtifacts } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REMOTION_ENTRY = path.resolve(__dirname, "..", "remotion", "index.ts");

const FPS = 24;

/**
 * Produce a short "v{pkg} · {sha}" string for the on-video badge so a
 * reviewer can tell at a glance which CLI commit produced a given video.
 * Resolved lazily and cached — runs at render time, not at module load, so
 * unit tests and imports don't execute git. We resolve once per process.
 */
let cachedVersionTag: string | null = null;
function getVersionTag(): string {
  if (cachedVersionTag) return cachedVersionTag;
  // ESM-safe path resolution. The built output is ESM (tsconfig "module":
  // "ESNext"), so `__dirname` is undefined here — using it threw silently
  // and the version badge fell back to a hardcoded default. fileURLToPath
  // works in both ESM and the tsx dev runner.
  let pkgVer = "0.0.0-unknown";
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(path.dirname(here), "..", "package.json");
    pkgVer = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? pkgVer;
  } catch {}
  cachedVersionTag = `v${pkgVer}`;
  return cachedVersionTag;
}

/**
 * One body narration beat. The narrator picks BOTH the timestamp and the
 * duration based on the moment timeline, so when we synth this beat into
 * its own audio file and place it at startS, the spoken word lands exactly
 * when the corresponding visual happens. Sum of all chunks ≈ masterDurS;
 * non-overlapping; cover the body contiguously.
 */
export interface BodyChunk {
  /** Body-relative seconds (0 = first frame of master). */
  startS: number;
  /** Slot duration for this beat. The narrator's text was sized for this. */
  durS: number;
  /** Caption text — must match the voice line word-for-word. */
  text: string;
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
}

/**
 * One on-screen overlay badge that pops up during a SILENT investigative
 * moment (browser_evaluate, network probe, etc.). Body-relative timestamps,
 * decoupled from the narration audio so they never desync with the actual
 * visual moment even if a beat's audio drifts a fraction of a second.
 */
export interface BodyBadge {
  /** Body-relative seconds (0 = first frame of master video). */
  startS: number;
  /** Visible duration. Clamped at render time to fit inside the body. */
  durS: number;
  /** 4-7 word plain-English summary, e.g. "checking the today filter". */
  label: string;
  /** Optional terminal-style one-liner, ≤60 chars. */
  detail?: string;
}

/** One row on the outro checklist. Replaces the abstract pass/fail
 *  blocks with the actual goals the agent ran, scannable by a reviewer
 *  in seconds. `note` is shown on a second line (smaller) when present.
 *  `goalId` lets the outro AND the PR comment GROUP rows by which goal
 *  they belong to — same data, two surfaces. */
export interface ChecklistItem {
  outcome: "success" | "failure" | "skipped";
  label: string;
  note?: string;
  goalId?: string;
}

export interface SingleVideoInput {
  title: string;
  summary: string;
  masterVideoSrc: string;
  viewport: { width: number; height: number };
  masterDurS: number;
  introDurFrames: number;
  outroDurFrames: number;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  introVoiceSrc?: string;
  introVoiceDurS?: number;
  introVoicePlaybackRate?: number;
  introCaption?: string;
  outroVoiceSrc?: string;
  outroVoiceDurS?: number;
  outroVoicePlaybackRate?: number;
  outroCaption?: string;
  versionTag?: string;
  /** Body narration as TIMED beats — one chunk per narrator-defined beat.
   *  Each chunk renders ONE Audio + ONE WordCaption Sequence at its declared
   *  startS, so the spoken word is anchored to the visual moment by
   *  construction (no global drift). Chunks are sorted, non-overlapping,
   *  cover the master body. */
  bodyChunks: BodyChunk[];
  /** Optional overlay badges keyed to silent investigative moments. */
  bodyBadges?: BodyBadge[];
  /** Animated check / cross / dash stamps timed to the moment each goal
   *  was decided by the agent. Body-relative seconds. */
  verificationStamps?: Array<{ atS: number; outcome: "success" | "failure" | "skipped"; label: string }>;
  /** Agent-planned camera plan — one entry per demo step in body-relative
   *  seconds. The Remotion compositor reads this instead of the reactive
   *  click-driven pan-zoom rules: each entry's `mode` (tight / wide /
   *  follow) drives zoom, optional focus is in viewport pixels (same
   *  coord space as `interactions`). When this is provided pan-zoom is
   *  ENTIRELY agent-directed; legacy rules only run if it's empty. */
  cameraPlan?: Array<{ startS: number; durS: number; mode: "tight" | "wide" | "follow"; focusX?: number; focusY?: number }>;
  /** Body-relative intervals where the pan-zoom should RELEASE to neutral
   *  framing. Computed from page-side MutationObserver data: whenever a
   *  click triggers DOM mutations OUTSIDE the clicked element's bbox
   *  (e.g. toast appears in the corner, counter at the top updates), the
   *  ride-mode held zoom would clip those changes off-frame. Each
   *  interval covers the post-click window where off-target mutations
   *  occurred so the viewer sees the full page during state changes. */
  zoomReleaseIntervals?: Array<{ startS: number; durS: number }>;
  /** Mouse + click + keystroke stream, mapped from raw video timeline into
   *  master-timeline seconds (so timestamps line up with the trimmed video).
   *  Remotion renders a cinematic cursor overlay using `move`+`click` events
   *  and pans/zooms the body video toward each click. Interactions that
   *  landed in a trimmed-out idle gap are dropped before this is built. */
  interactions?: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>;
  /** Per-goal results rendered as a vertical checklist on the outro. */
  checklist?: ChecklistItem[];
  /** Goal-level headings that drive the outro's GROUPING — one heading
   *  per goal, ordered so the viewer reads them in the same sequence the
   *  agent ran them. The Outro component uses these to bucket `checklist`
   *  rows by their `goalId` and render a heading above each bucket.
   *  Mirrors the grouping the PR comment uses (src/pr.ts buildChecklistMarkdown). */
  goalGroups?: Array<{ id: string; label: string; outcome: "success" | "failure" | "skipped" }>;
}

/**
 * Classify a tool kind for the body narration:
 *   "silent"  — investigative work with no visible UI change (evaluate,
 *               network, console). Gets a top-of-frame BADGE on top of
 *               the narration so the viewer can see what's being checked.
 *   "visible" — user-visible interaction (click, type, press, nav). Gets
 *               narration only — the action is visible on screen so a
 *               badge would just clutter the frame.
 *   "skip"    — plumbing the viewer shouldn't care about. We don't make a
 *               scene boundary here; the narration of the surrounding scenes
 *               extends to cover the dead air naturally.
 */
function classifyTool(kind: string): "silent" | "visible" | "skip" {
  // Pass-2 demo-replay tool windows: classify the visible step kinds as
  // "visible" so they (a) anchor narration windows next to the action,
  // and (b) keep the trim plan from collapsing them as idle. Without
  // this, every replay_* kind fell through to the default "skip" bucket,
  // which silently broke audio/caption sync — the trim plan compressed
  // the goal-action stretches as if they were dead air, while login
  // clicks (also no tool window) DID get used as narration anchors via
  // page-side __tikRecord. Net effect: narration distributed across
  // login windows + early dwells, then goal visuals played 5-10s late.
  if (kind.startsWith("replay_")) {
    if (kind === "replay_wait" || kind === "replay_navigate" || kind.endsWith("_skipped")) return "skip";
    return "visible";
  }
  switch (kind) {
    case "browser_evaluate":
    case "browser_network_requests":
    case "browser_console_messages":
      return "silent";
    case "browser_click":
    case "browser_fill_form":
    case "browser_type":
    case "browser_press_key":
    case "browser_hover":
    case "browser_scroll":
    case "browser_navigate":
    case "browser_navigate_back":
    case "browser_wait_for":
    case "browser_take_screenshot":
      return "visible";
    case "browser_snapshot":
    case "browser_tabs":
    case "ToolSearch":
    case "Read":
    case "Glob":
    case "Bash":
      return "skip";
    default: return "skip";
  }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, run));
  return results;
}

function sanitiseForSpeech(s: string): string {
  // Em-dashes read awkwardly in TTS and double as caption page breaks in
  // WordCaption.paginate, so strip them here as a belt-and-braces rule
  // (the narrator prompt also forbids them). Replace with comma-space so
  // the cadence stays close to what the narrator wrote.
  return s
    .replace(/[✓✗⚠✨📸🎬]/g, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/·/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SingleVideoEditOptions {
  artifacts: RunArtifacts;
  outPath: string;
  voice?: string | null;
  quick?: boolean;
  prTitle?: string;
  prBody?: string;
  focus?: string;
  /** Optional checklist already synthesised by the caller (e.g. the `run`
   *  CLI command, which now always generates the checklist before deciding
   *  whether to render the video). When provided, we reuse it for the outro
   *  instead of paying for a second Claude call. Pass `null` to indicate the
   *  caller tried but the LLM call returned nothing — same fallback path
   *  fires as if we'd never had a checklist. Omit to let the editor
   *  synthesise one itself (the original path, still used by `pr` mode). */
  precomputedChecklist?: ChecklistItem[] | null;
}

interface TrimSegment {
  rawStartS: number;
  rawEndS: number;
  speed: number;
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
  active.sort((a, b) => a.start - b.start);
  // Merge tolerance debounces the segment cuts: tools that fire within
  // TRIM_MERGE_S of each other (e.g. browser_click → browser_snapshot ~200ms
  // later) collapse into a single active window, eliminating the cut + tiny
  // idle-gap segment between them. Big lever on render time — the master
  // ffmpeg pass scales linearly with segment count, and cutting from 73 to
  // ~25 segments cuts the master encode roughly in half.
  const merged: typeof active = [];
  for (const w of active) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + TRIM_MERGE_S) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  if (active.length > merged.length) {
    console.log(chalk.dim(`  merged ${active.length} active windows → ${merged.length} (TIK_TRIM_MERGE_S=${TRIM_MERGE_S}s)`));
  }

  let cursor = 0;
  let trimmedCursor = 0;
  let isFirstIdle = true;
  for (const w of merged) {
    const idleBefore = w.start - cursor;
    if (idleBefore > idleThresholdS) {
      const cap = isFirstIdle ? 1.2 : 0.6;
      const idleTrimmedDurS = Math.min(idleBefore / idleSpeed, cap);
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
    isFirstIdle = false;
  }
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
  const last = plan[plan.length - 1];
  return last ? last.trimmedEndS : rawS;
}

async function renderTrimmedMaster(rawMp4: string, outMp4: string, plan: TrimSegment[]): Promise<void> {
  // Per-segment encode → concat-demuxer copy. The previous approach built one
  // big filter_complex with N parallel trim/setpts substreams feeding concat;
  // ffmpeg buffered every substream in lockstep, and on long captures with
  // 25+ segments that pushed the 7 GB runner over the OOM line (exit 143).
  // Encoding each segment in its own process bounds memory to ~one segment's
  // worth and lets us use input-side -ss to skip decoding the rest of the
  // file. The final concat is a stream copy so we don't pay the encode twice.
  const partsDir = path.join(path.dirname(outMp4), `trim-parts-${process.pid}`);
  await mkdir(partsDir, { recursive: true });
  try {
    const segments = plan.filter((s) => s.rawEndS - s.rawStartS > 0.001);
    const partPaths: string[] = new Array(segments.length);
    // Bounded concurrency keeps total memory predictable on small runners
    // even when there are many segments. 2 is enough to overlap I/O with
    // CPU on the master encode without doubling resident RAM.
    const concurrency = Math.max(1, Math.min(2, segments.length));
    await runWithConcurrency(segments, concurrency, async (s, i) => {
      const partPath = path.join(partsDir, `part-${String(i).padStart(3, "0")}.mp4`);
      const trimDur = s.rawEndS - s.rawStartS;
      const filterParts: string[] = [];
      // For high-speed idle segments, drop frames BEFORE setpts via select
      // so ffmpeg doesn't burn CPU/RAM decoding frames the output framerate
      // would throw away. With idle gaps ranging 5x–100x speed, this is the
      // difference between decoding ~720 frames or ~14 for a 30s gap. Stride
      // is capped so we always keep at least a few frames per segment for
      // motion continuity in moderate speedups.
      if (s.speed > 2.0) {
        const stride = Math.max(1, Math.min(Math.floor(s.speed), Math.floor(trimDur * FPS / 2) || 1));
        filterParts.push(`select='not(mod(n\\,${stride}))'`);
      }
      filterParts.push(`setpts=${(1 / s.speed).toFixed(4)}*(PTS-STARTPTS)`);
      // -ss before -i is the fast (keyframe) seek; stagedRaw is encoded with
      // a 1-second GOP (-g 24 -keyint_min 24) so the seek lands within at
      // most one frame of the requested timestamp.
      await runFfmpeg([
        "-ss", s.rawStartS.toFixed(3),
        "-i", rawMp4,
        "-t", trimDur.toFixed(3),
        "-filter:v", filterParts.join(","),
        "-an",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "20",
        "-r", String(FPS),
        "-pix_fmt", "yuv420p",
        partPath,
      ]);
      partPaths[i] = partPath;
    });

    const listPath = path.join(partsDir, "concat.txt");
    const listContent = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, listContent);
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outMp4,
    ]);
  } finally {
    await rm(partsDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface SingleVideoEditResult {
  outPath: string;
  /** Granular per-check list with each item carrying a `goalId` so the
   *  video outro AND the PR comment can render them grouped by goal.
   *  Same data shape both places — they just present it differently. */
  checklist: ChecklistItem[];
}

/**
 * 2-pass renderer. Pass 1 trims the raw recording into a final-length
 * master video. Pass 2 derives a complete scene list from that master
 * (intro + per-tool moments + outro), asks Claude for ONE coherent
 * narration script sized to those scenes, TTS each chunk, then chains the
 * audio + captions back-to-back so the final video has continuous voice
 * across the whole timeline with zero overlap and zero silence.
 */
export async function editSingleVideo({
  artifacts, outPath, voice = "Samantha", quick = false,
  prTitle, prBody, focus, precomputedChecklist,
}: SingleVideoEditOptions): Promise<SingleVideoEditResult> {
  const runDir = artifacts.runDir;
  const publicDir = path.join(runDir, "public");
  await mkdir(publicDir, { recursive: true });

  // ── 1. Stage raw → MP4 for consistent frame rate. Force a 1-second GOP
  //      (-g/-keyint_min = FPS) so the per-segment trim pass below can use
  //      input-side -ss for fast keyframe seek and still land within one
  //      frame of the requested cut points.
  const stagedRaw = path.join(runDir, "raw.mp4");
  await runFfmpeg([
    "-i", artifacts.rawVideoPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-r", String(FPS), "-pix_fmt", "yuv420p",
    "-g", String(FPS), "-keyint_min", String(FPS), "-sc_threshold", "0",
    "-an",
    stagedRaw,
  ]);
  const rawDurS = await ffprobeDuration(stagedRaw);
  console.log(chalk.dim(`  raw: ${rawDurS.toFixed(1)}s @ ${artifacts.plan.viewport?.width ?? 1920}×${artifacts.plan.viewport?.height ?? 1080}`));

  const viewport = artifacts.plan.viewport ?? { width: 1920, height: 1080 };
  const ttsBackend: TTSBackend = resolveBackend(voice, artifacts.plan.name);
  console.log(chalk.dim(`  voice-over: ${describeBackend(ttsBackend)}`));

  // ── 2. Compute raw active windows from event + tool times. NO narration
  //      yet — narration is generated in pass 2 once we know the final
  //      master timeline.
  const BORING_KINDS = new Set(["script", "wait", "navigate"]);
  const visibleEvents = artifacts.events.filter((e) => !BORING_KINDS.has(e.kind));
  const hasToolWindows = !!(artifacts.toolWindows && artifacts.toolWindows.length > 0);
  const rawWindows: ActiveWindow[] = [];
  for (const ev of visibleEvents) {
    if (hasToolWindows && ev.kind === "intent") continue;
    rawWindows.push({
      start: Math.max(0, ev.startMs / 1000 - 0.1),
      end: Math.min(rawDurS, ev.endMs / 1000 + 0.25),
    });
  }
  if (artifacts.toolWindows && artifacts.toolWindows.length > 0) {
    let trimmedSkipCount = 0;
    for (const tw of artifacts.toolWindows) {
      // Skip the "skip" class (browser_snapshot, ToolSearch, Read, Glob,
      // Bash) — these are agent-thinking moments where the page sits
      // motionless. Adding them to rawWindows tells the trim planner
      // they're "active" and worth keeping, which produces visible
      // pauses in the final video. Drop them so the trim planner
      // collapses those stretches into idle gaps and removes them.
      if (classifyTool(tw.kind) === "skip") { trimmedSkipCount++; continue; }
      const s = Math.max(0, Math.min(rawDurS, tw.startMs / 1000));
      const e = Math.max(s + 0.2, Math.min(rawDurS, tw.endMs / 1000));
      rawWindows.push({ start: s, end: e });
    }
    if (trimmedSkipCount) console.log(chalk.dim(`  trimmed ${trimmedSkipCount} agent-thinking tool windows (snapshot/read/etc)`));
  }

  // ── 3. Build trim plan + render master. After this we know `masterDurS`.
  const plan = buildTrimPlan(rawDurS, rawWindows);
  const masterMp4Rel = "master.mp4";
  const masterMp4 = path.join(publicDir, masterMp4Rel);
  console.log(chalk.dim(`  trimming idle stretches (plan has ${plan.length} segments)…`));
  await renderTrimmedMaster(stagedRaw, masterMp4, plan);
  const masterDurS = await ffprobeDuration(masterMp4);
  console.log(chalk.dim(`  master: ${masterDurS.toFixed(1)}s (from ${rawDurS.toFixed(1)}s raw)`));

  // ── 4. Build the SCENE LIST in composition timeline.
  //      INTRO(0..introTargetS) → body moments(introTargetS+x..) → OUTRO.
  //      Body moments come from non-skip tool windows mapped raw→trimmed,
  //      coalesced so we don't end up with a chunk shorter than 1.6s.
  // Scene density + intro/outro durations are now configurable knobs —
  // see src/timeouts.ts for env vars and defaults.

  type BodyMoment = { startS: number; visibility: "silent" | "visible"; toolKind: string; toolInput?: string; toolResult?: string };
  const surfacing = (artifacts.toolWindows ?? [])
    .map((tw) => ({ tw, vis: classifyTool(tw.kind) }))
    .filter((x) => x.vis !== "skip");

  const bodyMomentsRaw: BodyMoment[] = surfacing
    .map((s) => ({
      startS: rawToTrimmed(s.tw.startMs / 1000, plan),
      visibility: s.vis as "silent" | "visible",
      toolKind: s.tw.kind,
      toolInput: s.tw.input,
      toolResult: s.tw.result,
    }))
    .sort((a, b) => a.startS - b.startS);

  // Ensure the first moment is anchored at 0 — otherwise the opening
  // seconds of the master have no narration anchor.
  const anchoredMoments: BodyMoment[] = [];
  if (bodyMomentsRaw.length === 0) {
    anchoredMoments.push({ startS: 0, visibility: "visible", toolKind: "intro-cover" });
  } else {
    if (bodyMomentsRaw[0].startS > 0.4) {
      anchoredMoments.push({ ...bodyMomentsRaw[0], startS: 0 });
      for (let i = 1; i < bodyMomentsRaw.length; i++) anchoredMoments.push(bodyMomentsRaw[i]);
    } else {
      anchoredMoments.push(...bodyMomentsRaw);
      anchoredMoments[0] = { ...anchoredMoments[0], startS: 0 };
    }
  }

  // Coalesce moments closer than MIN_CHUNK_S into the previous one — keeps
  // the narrator from having to anchor a thought to a too-tight cluster of
  // tool calls. Also caps the count at MAX_BODY_SCENES so the narration
  // prompt size stays bounded.
  let coalesced: BodyMoment[] = [];
  for (const m of anchoredMoments) {
    const last = coalesced[coalesced.length - 1];
    if (last && m.startS - last.startS < MIN_CHUNK_S) {
      // Merge into previous: keep prev's startS, but if THIS one is silent
      // and prev was visible, keep visible (the visible action is what the
      // viewer sees — silent investigation gets folded into its narration).
      if (last.visibility === "silent" && m.visibility === "visible") {
        last.visibility = "visible";
        last.toolKind = m.toolKind;
        last.toolInput = m.toolInput;
        last.toolResult = m.toolResult;
      }
      continue;
    }
    coalesced.push({ ...m });
  }
  // Hard ceiling: too many scenes blow past the narration CLI timeout.
  // Sample evenly while always keeping the first (anchored to 0) and last.
  if (coalesced.length > MAX_BODY_SCENES) {
    const stride = (coalesced.length - 1) / (MAX_BODY_SCENES - 1);
    const sampled: BodyMoment[] = [];
    for (let i = 0; i < MAX_BODY_SCENES; i++) {
      sampled.push(coalesced[Math.round(i * stride)]);
    }
    console.log(chalk.dim(`  capped body scenes ${coalesced.length} → ${sampled.length} for narration timeout safety`));
    coalesced = sampled;
  }

  // ── 5. Map raw-video-ms interactions onto the trimmed master timeline.
  //      Clicks are the timing anchors for narration windows, so we need
  //      them in body-relative seconds before we build the windows.
  type MappedInteraction = { tsMs: number; tsS: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string };
  const mappedInteractions: MappedInteraction[] = [];
  if (artifacts.interactions?.length) {
    for (const ev of artifacts.interactions) {
      const rawS = ev.ts / 1000;
      let mappedS: number | null = null;
      for (const seg of plan) {
        if (rawS >= seg.rawStartS && rawS <= seg.rawEndS + 1e-6) {
          mappedS = seg.trimmedStartS + (rawS - seg.rawStartS) / seg.speed;
          break;
        }
      }
      if (mappedS == null) continue;
      mappedInteractions.push({
        tsMs: Math.max(0, Math.round(mappedS * 1000)),
        tsS: Math.max(0, mappedS),
        kind: ev.kind, x: ev.x, y: ev.y, key: ev.key,
      });
    }
    console.log(chalk.dim(`  interactions: ${mappedInteractions.length}/${artifacts.interactions.length} kept after trim mapping`));
  }

  // ── 6. Build CLICK-ANCHORED narration windows. The body is partitioned
  //      into segments separated by clicks (with very-close clicks merged
  //      into one anchor so we don't end up with sub-second windows nobody
  //      can narrate). The narrator writes ONE beat per window — beat
  //      timing is FIXED to the click that opens or closes the window, so
  //      the spoken word is anchored to the meaningful visual moment.
  const MIN_WINDOW_DUR_S = 1.5;
  // EXCLUDE pre-goal clicks from narration anchors. The login replay
  // (and any pre-goal setup) generates real DOM clicks that page-side
  // __tikRecord captures, so they end up in `interactions`. Without
  // this filter they become narration anchors, splitting the LLM's
  // narration budget across login + transition windows. The narrator
  // then writes goal-action narration that PLAYS DURING the login
  // visuals — the 5-10s caption-vs-video desync the user reports.
  // First-goal start in body-relative seconds = the cutoff.
  const goalEvents = artifacts.events.filter((e) => e.kind === "intent");
  const firstGoalStartBodyS = goalEvents.length > 0
    ? Math.max(0, rawToTrimmed(goalEvents[0].startMs / 1000, plan) - 0.2)
    : 0;
  const allClicks = mappedInteractions
    .filter((ev) => ev.kind === "click")
    .sort((a, b) => a.tsS - b.tsS);
  const clicks = allClicks.filter((c) => c.tsS >= firstGoalStartBodyS);
  if (allClicks.length !== clicks.length) {
    console.log(chalk.dim(`  excluded ${allClicks.length - clicks.length} pre-goal click(s) from narration anchors (login + transition)`));
  }
  // Match each click to its nearest "visible-action" tool window by time
  // proximity so we can include the clicked element's description in the
  // window context. This is what makes the difference between the narrator
  // saying "we click the button" vs "we click the new Bulk Archive button".
  const visibleTools = (artifacts.toolWindows ?? [])
    .filter((tw) => classifyTool(tw.kind) === "visible")
    .map((tw) => ({
      bodyS: rawToTrimmed(tw.startMs / 1000, plan),
      kind: tw.kind,
      input: tw.input ?? "",
      result: tw.result ?? "",
    }))
    .sort((a, b) => a.bodyS - b.bodyS);
  function describeClickAt(bodyS: number): { element: string; tool: string } {
    let best: typeof visibleTools[number] | null = null;
    let bestDt = Infinity;
    for (const t of visibleTools) {
      const dt = Math.abs(t.bodyS - bodyS);
      if (dt < 1.5 && dt < bestDt) { best = t; bestDt = dt; }
    }
    if (!best) return { element: "", tool: "click" };
    return { element: best.input || "", tool: best.kind };
  }
  // Merge clicks that are very close (≤ MIN_WINDOW_DUR_S apart) into a
  // single anchor — the leading click defines the window boundary. Without
  // this, double-tap interactions or quick form-fills produce too many
  // tiny windows for the narrator to fill.
  const anchors: Array<{ tsS: number; element: string; tool: string }> = [];
  for (const c of clicks) {
    const last = anchors[anchors.length - 1];
    if (last && c.tsS - last.tsS < MIN_WINDOW_DUR_S) continue;
    const desc = describeClickAt(c.tsS);
    anchors.push({ tsS: c.tsS, element: desc.element, tool: desc.tool });
  }
  const windows: NarrationWindow[] = [];
  // Build window boundaries: 0 → anchor[0] → anchor[1] → ... → masterDurS.
  for (let i = 0; i <= anchors.length; i++) {
    const startS = i === 0 ? 0 : anchors[i - 1].tsS;
    const endS = i < anchors.length ? anchors[i].tsS : masterDurS;
    if (endS - startS < 0.4) continue; // skip degenerate slivers
    const events = (artifacts.toolWindows ?? [])
      .filter((tw) => classifyTool(tw.kind) !== "skip")
      .map((tw) => ({
        startS: rawToTrimmed(tw.startMs / 1000, plan),
        kind: tw.kind,
        input: tw.input ?? "",
        result: tw.result ?? "",
      }))
      .filter((e) => e.startS >= startS && e.startS < endS)
      .map((e) => ({
        startS: e.startS,
        tool: e.kind,
        description: e.input.replace(/\s+/g, " ").slice(0, 140),
        result: e.result ? e.result.replace(/\s+/g, " ").slice(0, 140) : undefined,
      }));
    windows.push({
      idx: windows.length,
      startS, endS, durS: endS - startS,
      startingClick: i > 0 ? { tsS: anchors[i - 1].tsS, element: anchors[i - 1].element, tool: anchors[i - 1].tool } : undefined,
      endingClick: i < anchors.length ? { tsS: anchors[i].tsS, element: anchors[i].element, tool: anchors[i].tool } : undefined,
      events,
    });
  }
  // Edge case: no clicks at all → one window covering the whole body.
  if (windows.length === 0) {
    windows.push({
      idx: 0, startS: 0, endS: masterDurS, durS: masterDurS,
      events: (artifacts.toolWindows ?? [])
        .filter((tw) => classifyTool(tw.kind) !== "skip")
        .map((tw) => ({
          startS: rawToTrimmed(tw.startMs / 1000, plan),
          tool: tw.kind,
          description: (tw.input ?? "").replace(/\s+/g, " ").slice(0, 140),
          result: tw.result ? tw.result.replace(/\s+/g, " ").slice(0, 140) : undefined,
        })),
    });
  }
  console.log(chalk.dim(`  click-anchored windows: ${windows.length} (from ${clicks.length} clicks, merged to ${anchors.length} anchors)`));

  // Kick off the checklist Claude call in parallel — it doesn't depend on
  // narration. Skip when the caller already synthesised the checklist for us.
  const checklistPromise: Promise<ChecklistItem[] | null> =
    precomputedChecklist !== undefined
      ? Promise.resolve(precomputedChecklist)
      : generateChecklist({ artifacts, prTitle, prBody });

  // ── 7. Generate the narration: intro line + one beat per click window +
  //      outro line, structured as a demo around the test plan goals.
  const narration = await generateNarration({
    plan: artifacts.plan, prTitle, prBody, focus,
    introTargetS: INTRO_TARGET_S,
    bodyDurS: masterDurS,
    outroTargetS: OUTRO_TARGET_S,
    goals: artifacts.plan.goals ?? [],
    windows,
  });

  // ── 8. TTS the intro + each non-empty body beat + outro in parallel.
  type TtsJob = { id: string; text: string; fileName: string };
  const ttsJobs: TtsJob[] = [
    { id: "intro", text: narration.intro.text, fileName: "voice-intro.wav" },
    ...narration.body.beats.map((b, i) => ({ id: `beat-${i}`, text: b.text, fileName: `voice-beat-${String(i).padStart(3, "0")}.wav` })),
    { id: "outro", text: narration.outro.text, fileName: "voice-outro.wav" },
  ];
  const ttsResults = await runWithConcurrency(ttsJobs, 6, async (job) => {
    if (!ttsBackend || !job.text.trim()) return { src: undefined as string | undefined, dur: 0 };
    try {
      await synth(ttsBackend, sanitiseForSpeech(job.text), path.join(publicDir, job.fileName));
      return { src: job.fileName, dur: await ffprobeDuration(path.join(publicDir, job.fileName)) };
    } catch (e) {
      console.log(chalk.yellow(`  voice skipped for ${job.id}: ${(e as Error).message.split("\n")[0]}`));
      return { src: undefined, dur: 0 };
    }
  });
  const introTts = ttsResults[0];
  const outroTts = ttsResults[ttsResults.length - 1];
  const beatTts = ttsResults.slice(1, ttsResults.length - 1);

  // ── 9. Build the body chunk timeline — ONE BodyChunk per click window.
  //      Each chunk gets a per-beat playbackRate that fits its TTS audio
  //      to the window's fixed durS. Floor 0.7× / cap 1.5×; outside that
  //      range the narrator's word-budget aim was too far off and we
  //      accept a small tail of silence (or a clipped trailing word) over
  //      audibly distorted speech.
  const bodyChunks: BodyChunk[] = [];
  let totalBeatSlackS = 0;
  let narratedWindowCount = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const beat = narration.body.beats[i];
    const v = beatTts[i];
    let rate = 1;
    if (v.dur > 0) {
      const targetSpeechS = Math.max(0.5, w.durS - 0.05);
      rate = Math.max(0.7, Math.min(1.5, v.dur / targetSpeechS));
    }
    const playedS = v.dur > 0 ? v.dur / rate : 0;
    if (playedS > 0) narratedWindowCount++;
    totalBeatSlackS += Math.max(0, w.durS - playedS);
    bodyChunks.push({
      startS: w.startS,
      durS: w.durS,
      text: sanitiseForSpeech(beat.captionText),
      voiceSrc: v.src,
      voiceDurS: v.dur || undefined,
      voicePlaybackRate: rate,
    });
  }
  console.log(chalk.dim(`  body beats: ${narratedWindowCount}/${windows.length} narrated · total slack ${totalBeatSlackS.toFixed(1)}s of ${masterDurS.toFixed(1)}s body (${((totalBeatSlackS / masterDurS) * 100).toFixed(1)}%)`));

  // ── 10. Body badges — overlay cards for windows whose events include
  //       silent investigative tools. Pinned to the silent tool's
  //       body-relative timestamp inside its window.
  const badgeByWindow = new Map<number, { label: string; detail?: string }>(
    narration.badges.map((b) => [b.windowIdx, { label: b.label.trim(), detail: b.detail?.trim() || undefined }])
  );
  const bodyBadges: BodyBadge[] = [];
  for (const w of windows) {
    const badge = badgeByWindow.get(w.idx);
    if (!badge?.label) continue;
    const silentEvent = w.events.find((e) => classifyTool(e.tool) === "silent");
    const startS = silentEvent?.startS ?? w.startS;
    const durS = Math.max(1.0, Math.min(w.endS - startS, 5.0));
    bodyBadges.push({ startS, durS, label: badge.label, detail: badge.detail });
  }

  // ── 10b. Compute zoom-release intervals: post-click periods where a DOM
  //        mutation landed OUTSIDE the clicked element's bounding box. The
  //        page-side MutationObserver records each mutation's rect; for
  //        each click we find post-click mutations that aren't contained
  //        inside the click target's bbox (with padding for shadows/focus
  //        rings), and flag the corresponding window for release zoom.
  //
  //        Why: if you click a button at the bottom-left and a toast
  //        appears top-right, ride-mode would hold the zoom on the button
  //        and clip the toast off-frame. This signal forces a zoom-out
  //        for the gap so the viewer sees both regions.
  const RELEASE_PADDING_PX = 60;       // generous halo for drop shadows / focus rings
  const POST_CLICK_WINDOW_MS = 3500;   // mutations attributed to a click within this window
  const zoomReleaseIntervals: Array<{ startS: number; durS: number }> = [];
  if (artifacts.clickBboxes && artifacts.mutations) {
    const clicksWithBbox = artifacts.clickBboxes
      .map((c) => {
        const rawS = c.ts / 1000;
        let bodyS: number | null = null;
        for (const seg of plan) {
          if (rawS >= seg.rawStartS && rawS <= seg.rawEndS + 1e-6) {
            bodyS = seg.trimmedStartS + (rawS - seg.rawStartS) / seg.speed;
            break;
          }
        }
        return bodyS == null ? null : { ...c, bodyS };
      })
      .filter((c): c is NonNullable<typeof c> => c != null);
    for (const click of clicksWithBbox) {
      // Find any mutations in the post-click window that are OUTSIDE the
      // click element's padded bbox. A single off-target mutation is enough
      // to flag this gap for release.
      const postWindowEnd = click.ts + POST_CLICK_WINDOW_MS;
      const offTargetMutations = (artifacts.mutations ?? []).filter((m) => {
        if (m.ts < click.ts || m.ts > postWindowEnd) return false;
        const px = RELEASE_PADDING_PX;
        const cx1 = click.x - px;
        const cy1 = click.y - px;
        const cx2 = click.x + click.width + px;
        const cy2 = click.y + click.height + px;
        const mx1 = m.x;
        const my1 = m.y;
        const mx2 = m.x + m.width;
        const my2 = m.y + m.height;
        // Mutation is "inside the click region" if its bbox is fully
        // contained in the padded click bbox. Otherwise it's off-target.
        const insideClick = mx1 >= cx1 && mx2 <= cx2 && my1 >= cy1 && my2 <= cy2;
        return !insideClick;
      });
      if (offTargetMutations.length === 0) continue;
      // The release interval covers from the click forward to whichever
      // comes first: the last off-target mutation (+ small lag) or the
      // post-click window boundary.
      const firstOffTargetMs = offTargetMutations[0].ts;
      const lastOffTargetMs = offTargetMutations[offTargetMutations.length - 1].ts;
      const startMs = Math.min(firstOffTargetMs, click.ts + 200); // start just after the click
      const endMs = Math.min(postWindowEnd, lastOffTargetMs + 600); // 600ms lag so we don't snap back too soon
      const startBodyS = (() => {
        let s: number | null = null;
        for (const seg of plan) {
          if (startMs / 1000 >= seg.rawStartS && startMs / 1000 <= seg.rawEndS + 1e-6) {
            s = seg.trimmedStartS + (startMs / 1000 - seg.rawStartS) / seg.speed;
            break;
          }
        }
        return s;
      })();
      const endBodyS = (() => {
        let s: number | null = null;
        for (const seg of plan) {
          if (endMs / 1000 >= seg.rawStartS && endMs / 1000 <= seg.rawEndS + 1e-6) {
            s = seg.trimmedStartS + (endMs / 1000 - seg.rawStartS) / seg.speed;
            break;
          }
        }
        return s;
      })();
      if (startBodyS == null || endBodyS == null) continue;
      const durS = Math.max(0.5, endBodyS - startBodyS);
      zoomReleaseIntervals.push({ startS: startBodyS, durS });
    }
  }
  // Merge overlapping intervals so the compositor doesn't re-evaluate the
  // same gap multiple times.
  zoomReleaseIntervals.sort((a, b) => a.startS - b.startS);
  const mergedReleaseIntervals: typeof zoomReleaseIntervals = [];
  for (const iv of zoomReleaseIntervals) {
    const last = mergedReleaseIntervals[mergedReleaseIntervals.length - 1];
    if (last && iv.startS <= last.startS + last.durS + 0.1) {
      const newEnd = Math.max(last.startS + last.durS, iv.startS + iv.durS);
      last.durS = newEnd - last.startS;
    } else {
      mergedReleaseIntervals.push({ ...iv });
    }
  }
  if (mergedReleaseIntervals.length) {
    console.log(chalk.dim(`  zoom-release intervals: ${mergedReleaseIntervals.length} (post-click off-target mutations detected)`));
  }

  // ── 8. Intro / outro durations based on actual voice length.
  const introDurS = Math.max(INTRO_TARGET_S, introTts.dur + 0.5);
  // Outro holds for OUTRO_HOLD_S seconds after the voice ends so the
  // checklist stays readable on the final frame (Outro no longer fades).
  const outroDurS = Math.max(OUTRO_TARGET_S + OUTRO_HOLD_S, outroTts.dur + OUTRO_HOLD_S);
  const introDurFrames = Math.round(introDurS * FPS);
  const outroDurFrames = Math.round(outroDurS * FPS);
  const introPlaybackRate = introTts.dur > 0 ? Math.max(0.85, Math.min(1.4, introTts.dur / Math.max(0.5, introDurS - 0.2))) : 1;
  const outroPlaybackRate = outroTts.dur > 0 ? Math.max(0.85, Math.min(1.4, outroTts.dur / Math.max(0.5, outroDurS - 0.2))) : 1;

  // ── 9. Stats for intro/outro cards.
  const passed = artifacts.events.filter((e) => e.outcome === "success").length;
  const failed = artifacts.events.filter((e) => e.outcome === "failure").length;
  const skipped = artifacts.events.filter((e) => e.outcome === "skipped").length;
  const stats = { passed, failed, skipped, total: artifacts.events.length, durS: artifacts.totalMs / 1000 };

  // Outro checklist. PREFERRED: the Claude-generated granular list
  // (synthesised from goals + agent action history) — but each row now
  // carries a `goalId` so both the video outro AND the PR comment can
  // render the items GROUPED BY GOAL. That keeps every sub-check the
  // agent actually ran visible while making it crystal-clear which
  // beat they belong to. FALLBACK: one row per goal, if synthesis
  // returned null — still valid output, just less detail.
  let checklist: ChecklistItem[] = [];
  const llmList = await checklistPromise;
  if (llmList && llmList.length > 0) {
    checklist = llmList;
    const grouped = checklist.reduce<Record<string, number>>((a, c) => { const k = c.goalId ?? "_ungrouped"; a[k] = (a[k] ?? 0) + 1; return a; }, {});
    console.log(chalk.dim(`  checklist: ${llmList.length} llm-synthesised items across ${Object.keys(grouped).length} goal group${Object.keys(grouped).length === 1 ? "" : "s"}`));
  } else {
    const goalEvents = artifacts.events.filter((e) => e.kind === "intent");
    const ranked = [...goalEvents].sort((a, b) => {
      const aFail = a.outcome === "failure" ? 0 : 1;
      const bFail = b.outcome === "failure" ? 0 : 1;
      return aFail - bFail;
    });
    checklist = ranked.slice(0, 6).map((e) => ({
      outcome: e.outcome,
      label: clipToWord((e.shortLabel ?? e.description).replace(/\s+/g, " ").trim(), 40),
      note: e.shortNote ? clipToWord(e.shortNote.replace(/\s+/g, " ").trim(), 80) : undefined,
      goalId: e.stepId,
    }));
    console.log(chalk.dim(`  checklist: ${checklist.length} fallback goal-level items`));
  }

  // Reuse the click + move + key stream we mapped earlier (used for
  // building the click-anchored narration windows) — Remotion's cursor
  // overlay and pan-zoom logic want body-relative ms timestamps, so we
  // strip the body-seconds field and keep only the canonical ms shape.
  const remotionInteractions: SingleVideoInput["interactions"] = mappedInteractions
    .map((ev) => ({ ts: ev.tsMs, kind: ev.kind, x: ev.x, y: ev.y, key: ev.key }));

  // Verification stamps — one animated check / cross / dash per goal,
  // pinned to the moment the agent declared the OUTCOME. We anchor at
  // event endMs (decision moment) and pull `shortLabel` if the agent
  // produced one, falling back to a trimmed description. Stamps live
  // 1.8s on screen; if two goals end within that window the editor
  // de-overlaps them so the viewer never sees stamped goals on top of
  // each other.
  const STAMP_DUR_S = 1.8;
  const STAMP_GAP_S = 0.25;
  const stampCandidates = goalEvents
    .map((e) => {
      const rawEndS = e.endMs / 1000;
      let bodyS = rawToTrimmed(rawEndS, plan);
      // Pull stamps slightly INSIDE the body so the entrance animation
      // isn't clipped by the master end. Also nudge off the very start.
      bodyS = Math.max(0.1, Math.min(masterDurS - 0.1, bodyS));
      const label = clipToWord((e.shortLabel ?? e.description ?? "").replace(/\s+/g, " ").trim(), 48);
      return label ? { atS: bodyS, outcome: e.outcome, label } : null;
    })
    .filter((x): x is { atS: number; outcome: typeof goalEvents[number]["outcome"]; label: string } => !!x)
    .sort((a, b) => a.atS - b.atS);
  const verificationStamps: Array<{ atS: number; outcome: "success" | "failure" | "skipped"; label: string }> = [];
  let lastEndS = -Infinity;
  for (const c of stampCandidates) {
    const minStartS = lastEndS + STAMP_GAP_S;
    const atS = Math.max(c.atS, minStartS);
    if (atS >= masterDurS - 0.2) continue; // no room before body ends
    verificationStamps.push({ atS, outcome: c.outcome, label: c.label });
    lastEndS = atS + STAMP_DUR_S;
  }
  // Convert the raw-ms cameraPlan from the runner into body-relative
  // seconds. Drop entries whose window doesn't intersect the trim plan
  // (those are pure dead air the editor cropped out anyway).
  const cameraPlanBody: Array<{ startS: number; durS: number; mode: "tight" | "wide" | "follow"; focusX?: number; focusY?: number }> = [];
  for (const entry of artifacts.cameraPlan ?? []) {
    const startBodyS = rawToTrimmed(entry.startMs / 1000, plan);
    const endBodyS = rawToTrimmed(entry.endMs / 1000, plan);
    const durS = Math.max(0.05, endBodyS - startBodyS);
    if (startBodyS >= masterDurS - 0.05) continue;
    cameraPlanBody.push({ startS: Math.max(0, startBodyS), durS, mode: entry.mode, focusX: entry.focusX, focusY: entry.focusY });
  }
  cameraPlanBody.sort((a, b) => a.startS - b.startS);
  if (cameraPlanBody.length > 0) {
    const counts = cameraPlanBody.reduce<Record<string, number>>((a, e) => { a[e.mode] = (a[e.mode] ?? 0) + 1; return a; }, {});
    console.log(chalk.dim(`  camera plan (body-relative): ${cameraPlanBody.length} entries (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")})`));
  }

  if (verificationStamps.length > 0) {
    console.log(chalk.dim(`  verification stamps: ${verificationStamps.length} (${verificationStamps.filter(s => s.outcome === "success").length} pass / ${verificationStamps.filter(s => s.outcome === "failure").length} fail / ${verificationStamps.filter(s => s.outcome === "skipped").length} skip)`));
  }

  const input: SingleVideoInput = {
    title: artifacts.plan.name || "Feature review",
    summary: artifacts.plan.summary || artifacts.plan.startUrl,
    masterVideoSrc: masterMp4Rel,
    viewport,
    masterDurS,
    introDurFrames,
    outroDurFrames,
    stats,
    introVoiceSrc: introTts.src,
    introVoiceDurS: introTts.dur || undefined,
    introVoicePlaybackRate: introPlaybackRate,
    introCaption: sanitiseForSpeech(narration.intro.captionText),
    outroVoiceSrc: outroTts.src,
    outroVoiceDurS: outroTts.dur || undefined,
    outroVoicePlaybackRate: outroPlaybackRate,
    outroCaption: sanitiseForSpeech(narration.outro.captionText),
    versionTag: getVersionTag(),
    bodyChunks,
    bodyBadges: bodyBadges.length > 0 ? bodyBadges : undefined,
    verificationStamps: verificationStamps.length > 0 ? verificationStamps : undefined,
    cameraPlan: cameraPlanBody.length > 0 ? cameraPlanBody : undefined,
    zoomReleaseIntervals: mergedReleaseIntervals.length > 0 ? mergedReleaseIntervals : undefined,
    interactions: remotionInteractions.length > 0 ? remotionInteractions : undefined,
    checklist: checklist.length > 0 ? checklist : undefined,
    // Goal-level headings for the outro's grouping — derived from the
    // same intent events the checklist's goalIds reference. We only
    // surface this when at least one checklist row carries a goalId
    // (otherwise the outro silently falls back to a flat list).
    goalGroups: goalEvents.length > 0 && checklist.some((c) => !!c.goalId)
      ? goalEvents.map((e) => ({
          id: e.stepId,
          label: clipToWord((e.shortLabel ?? e.description ?? "").replace(/\s+/g, " ").trim(), 48) || "Goal",
          outcome: e.outcome,
        }))
      : undefined,
  };
  await writeFile(path.join(runDir, "reel-input.json"), JSON.stringify(input, null, 2));

  // ── 10. Bundle + render via Remotion.
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

  const totalFrames = composition.durationInFrames;
  const segmentsCfg = Math.max(1, Math.min(4, RENDER_SEGMENTS));
  const segments = totalFrames < 240 ? 1 : segmentsCfg;
  const perSegConcurrency = Math.max(2, Math.min(
    Number(process.env.TIK_RENDER_CONCURRENCY) || 8,
    Math.floor(os.cpus().length / Math.max(1, segments)),
  ));
  // Quick mode resolution is the dominant lever on render time — it scales
  // roughly linearly with pixel count. History:
  //   • 540×960 / 1200k / jpeg 70 — fastest, but app text was unreadable
  //     on crowded layouts (date inputs, dropdowns, badge text).
  //   • 720×1280 / 2500k / jpeg 80 — legible but ~78% more pixels than the
  //     original, and renders felt sluggish on the self-test workflow.
  //   • 648×1152 / 2000k / jpeg 80 — current. Exactly 0.6× of native
  //     1080×1920, ~44% more pixels than the 540×960 baseline (small enough
  //     to keep render time tolerable) but still 50% sharper, which is
  //     where in-app text legibility comes from.
  // Both dimensions stay /8-aligned so x264/h264 chroma subsampling stays
  // happy. Override at build time with TIK_RENDER_SCALE (a fraction of
  // native, e.g. 0.5 for the old quick mode, 0.667 for the previous bump).
  const scaleEnv = Number(process.env.TIK_RENDER_SCALE);
  const scale = quick
    ? (Number.isFinite(scaleEnv) && scaleEnv > 0 && scaleEnv <= 1 ? scaleEnv : 0.6)
    : 1;
  const align8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);
  const effectiveWidth = align8(composition.width * scale);
  const effectiveHeight = align8(composition.height * scale);
  console.log(chalk.dim(`  rendering ${totalFrames} frames (${(totalFrames / FPS).toFixed(1)}s) at ${effectiveWidth}×${effectiveHeight} — ${segments}× parallel segment${segments === 1 ? "" : "s"} · concurrency ${perSegConcurrency}…`));

  const videoBitrate = (quick ? "2000k" : "6000k") as `${number}k`;
  const audioBitrate: `${number}k` = "160k";
  const glBackend = (process.env.TIK_REMOTION_GL as any)
    ?? (process.platform === "darwin" ? "angle" : "angle-egl");
  const sharedRenderOpts = {
    serveUrl: bundleOutput,
    codec: "h264" as const,
    inputProps: input as any,
    audioCodec: "aac" as const,
    enforceAudioTrack: true,
    concurrency: perSegConcurrency,
    jpegQuality: quick ? 80 : 88,
    chromiumOptions: { gl: glBackend },
    // Per-segment cache. Was 512 MB hard-coded, but with N parallel
    // segments × big captures it pushed standard CI runners (≈7 GB) over
    // the OOM line and got SIGTERM'd (exit 143). Tunable via env now;
    // action.yml ships a 256 MB default for CI safety.
    offthreadVideoCacheSizeInBytes: Math.max(64, OFFTHREAD_VIDEO_CACHE_MB) * 1024 * 1024,
    videoBitrate,
    audioBitrate,
    hardwareAcceleration: "if-possible" as const,
    x264Preset: "veryfast" as const,
    overwrite: true,
    logLevel: (process.env.TIK_REMOTION_DEBUG ? "verbose" : "error") as "verbose" | "error",
  };

  const renderStart = Date.now();
  if (segments === 1) {
    let lastReportedPct = -1;
    await renderMedia({
      ...sharedRenderOpts,
      composition: { ...composition, width: effectiveWidth, height: effectiveHeight },
      outputLocation: outPath,
      onProgress: ({ progress, renderedFrames, encodedFrames }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= lastReportedPct + 2 || pct === 100) {
          const elapsed = (Date.now() - renderStart) / 1000;
          const fps = renderedFrames && elapsed > 0 ? (renderedFrames / elapsed).toFixed(1) : "—";
          const eta = pct > 0 ? Math.round(elapsed * (100 - pct) / pct) : undefined;
          console.log(chalk.dim(`    ${String(pct).padStart(3, " ")}%  rendered ${renderedFrames}/${totalFrames}  encoded ${encodedFrames}/${totalFrames}  ${fps} fps${eta != null ? ` · eta ${eta}s` : ""}`));
          lastReportedPct = pct;
        }
      },
    });
  } else {
    const chunkSize = Math.ceil(totalFrames / segments);
    const partsDir = path.join(runDir, "parts");
    await mkdir(partsDir, { recursive: true });
    const ranges: Array<{ start: number; end: number; path: string }> = [];
    for (let i = 0; i < segments; i++) {
      const start = i * chunkSize;
      const end = Math.min(totalFrames - 1, (i + 1) * chunkSize - 1);
      if (start > end) continue;
      ranges.push({ start, end, path: path.join(partsDir, `part-${String(i).padStart(2, "0")}.mp4`) });
    }

    const perSegRendered = new Array(ranges.length).fill(0);
    const perSegEncoded = new Array(ranges.length).fill(0);
    let lastReportedPct = -1;
    const reportProgress = () => {
      const totalRendered = perSegRendered.reduce((a, b) => a + b, 0);
      const totalEncoded = perSegEncoded.reduce((a, b) => a + b, 0);
      const pct = Math.floor((totalRendered / totalFrames) * 100);
      if (pct >= lastReportedPct + 2 || pct === 100) {
        const elapsed = (Date.now() - renderStart) / 1000;
        const fps = elapsed > 0 ? (totalRendered / elapsed).toFixed(1) : "—";
        const eta = pct > 0 ? Math.round(elapsed * (100 - pct) / pct) : undefined;
        console.log(chalk.dim(`    ${String(pct).padStart(3, " ")}%  rendered ${totalRendered}/${totalFrames}  encoded ${totalEncoded}/${totalFrames}  ${fps} fps${eta != null ? ` · eta ${eta}s` : ""}`));
        lastReportedPct = pct;
      }
    };
    await Promise.all(ranges.map((r, i) => renderMedia({
      ...sharedRenderOpts,
      composition: { ...composition, width: effectiveWidth, height: effectiveHeight },
      outputLocation: r.path,
      frameRange: [r.start, r.end],
      onProgress: ({ renderedFrames, encodedFrames }) => {
        perSegRendered[i] = renderedFrames;
        perSegEncoded[i] = encodedFrames;
        reportProgress();
      },
    })));

    console.log(chalk.dim(`  stitching ${ranges.length} segments…`));
    const listPath = path.join(partsDir, "concat.txt");
    const listContent = ranges.map((r) => `file '${r.path.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, listContent);
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outPath,
    ]);
    if (!process.env.TIK_KEEP_PARTS) {
      await rm(partsDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (!process.env.TIK_KEEP_PUBLIC) {
    await rm(publicDir, { recursive: true, force: true }).catch(() => {});
  }
  return { outPath, checklist };
}
