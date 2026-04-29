import { mkdir, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { runFfmpeg, ffprobeDuration, detectScenechanges } from "./ffmpeg.js";
import { resolveBackend, describeBackend, synth, type TTSBackend } from "./tts.js";
import { generateTimedNarration, type NarrationScene } from "./timed-narration.js";
import { generateChecklist } from "./checklist.js";
import {
  MIN_CHUNK_S, MAX_BODY_SCENES, TRIM_MERGE_S,
  INTRO_TARGET_S, OUTRO_TARGET_S, OUTRO_HOLD_S,
  RENDER_SEGMENTS, OFFTHREAD_VIDEO_CACHE_MB,
  KEEP_BEFORE_MS, KEEP_AFTER_MS, MAX_IDLE_TRIMMED_S,
  IDLE_MIN_SPEED, IDLE_MAX_SPEED, SCENECHANGE_THRESHOLD,
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
  let pkgVer = "0.1.0";
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pkgVer = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8")).version ?? pkgVer;
  } catch {}
  let sha = "";
  try {
    sha = execSync("git rev-parse --short=7 HEAD", { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {}
  cachedVersionTag = sha ? `v${pkgVer} · ${sha}` : `v${pkgVer}`;
  return cachedVersionTag;
}

/**
 * One slot in the body timeline. Slots are SORTED + NON-OVERLAPPING + COVER
 * the entire master video — voice and caption never stack and never leave
 * silence between them. Each slot's voice is sized via playbackRate to fit
 * its window exactly.
 */
export interface BodyChunk {
  /** Body-relative seconds (0 = first frame of master video). */
  startS: number;
  /** Window duration. Sum of all chunks ≈ masterDurS. */
  durS: number;
  /** Caption text (rendered word-by-word). Matches voice word-for-word. */
  text: string;
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
  /** Plain-English overlay label for SILENT investigation moments
   *  (browser_evaluate, network, screenshot-then-think). Shown as a small
   *  card near the top of the frame so the viewer sees what the agent is
   *  checking even when the UI is static. Empty for visible interactions. */
  badgeLabel?: string;
  /** Terminal-style technical detail (e.g. `evaluate document.querySelectorAll(...)`).
   *  Only meaningful when badgeLabel is set. */
  badgeDetail?: string;
}

/** One row on the outro checklist. Replaces the abstract pass/fail
 *  blocks with the actual goals the agent ran, scannable by a reviewer
 *  in seconds. `note` is shown on a second line (smaller) when present. */
export interface ChecklistItem {
  outcome: "success" | "failure" | "skipped";
  label: string;
  note?: string;
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
  /** Body narration timeline — back-to-back chunks that cover the full
   *  master duration. Each chunk owns its voice + caption + optional badge. */
  bodyChunks: BodyChunk[];
  /** Mouse + click + keystroke stream, mapped from raw video timeline into
   *  master-timeline seconds (so timestamps line up with the trimmed video).
   *  Remotion renders a cinematic cursor overlay using `move`+`click` events
   *  and pans/zooms the body video toward each click. Interactions that
   *  landed in a trimmed-out idle gap are dropped before this is built. */
  interactions?: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>;
  /** Per-goal results rendered as a vertical checklist on the outro. */
  checklist?: ChecklistItem[];
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

/**
 * Trim-plan anchor classification — distinct from classifyTool, which
 * controls the body scene list / badge overlays.
 *
 * "high" — actual user-visible interactions or verifications. The cursor
 *          moves, something gets clicked or typed, the page renders a
 *          result. We anchor the 1× window around these points so the
 *          viewer SEES what changed.
 * "low"  — agent-thinking tools where the page is static. browser_snapshot
 *          (DOM read), browser_evaluate (JS read), browser_wait_for
 *          (literally idle), browser_network_requests (in-memory). These
 *          DO NOT anchor a 1× window — the visual evidence is the badge
 *          overlay during the moment, not the unchanging page underneath.
 *          Anchoring them was the dominant source of 400s videos: every
 *          snapshot kept ~3s of static page at full speed.
 * "skip" — non-browser plumbing tools. Never an anchor.
 */
function anchorClass(kind: string): "high" | "low" | "skip" {
  switch (kind) {
    case "browser_click":
    case "browser_type":
    case "browser_fill_form":
    case "browser_press_key":
    case "browser_hover":
    case "browser_scroll":
    case "browser_navigate":
    case "browser_navigate_back":
    case "browser_select_option":
    case "browser_take_screenshot":
      return "high";
    case "browser_snapshot":
    case "browser_evaluate":
    case "browser_wait_for":
    case "browser_network_requests":
    case "browser_console_messages":
    case "browser_tabs":
      return "low";
    default:
      return "skip";
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

/**
 * Content-aware trim plan. Inputs are ACTIVE WINDOWS — pre-built around
 * anchor points (clicks, keystrokes, high-class tool calls, ffmpeg
 * scenechanges) by the caller. Each anchor brings KEEP_BEFORE_MS of lead-in
 * and KEEP_AFTER_MS of follow-through. We:
 *
 *   1. Merge overlapping windows (TRIM_MERGE_S tolerance).
 *   2. Keep merged active stretches at 1× — these contain real visual
 *      change, the viewer needs to see them.
 *   3. Idle gaps between active stretches get COMPRESSED VARIABLY:
 *      the longer the gap, the harder we crush, capped so no single
 *      idle stretch consumes more than MAX_IDLE_TRIMMED_S of trimmed
 *      output. A 30s loading-spinner stall comes out as 0.6s of
 *      blur instead of 6s of fast-forward.
 *
 * No "stratified sampling" — the active windows are kept LOSSLESSLY
 * (every frame at 1×). What gets compressed is provably-static dead air
 * between anchors.
 */
function buildTrimPlan(
  rawDurS: number,
  windows: ActiveWindow[],
): TrimSegment[] {
  const segments: TrimSegment[] = [];

  const compressIdle = (idleStart: number, idleEnd: number, trimmedCursor: number): TrimSegment => {
    const idleDur = Math.max(0, idleEnd - idleStart);
    // Tiny gaps (< 0.4s) aren't worth a cut; pass through at 1× so
    // ffmpeg doesn't fragment into hundreds of segments.
    if (idleDur < 0.4) {
      return {
        rawStartS: idleStart, rawEndS: idleEnd, speed: 1.0,
        trimmedStartS: trimmedCursor, trimmedEndS: trimmedCursor + idleDur,
      };
    }
    // Variable speed: compress to ≤ MAX_IDLE_TRIMMED_S of trimmed time,
    // bounded by [IDLE_MIN_SPEED, IDLE_MAX_SPEED]. A 60s stall gets
    // crushed as hard as 60/MAX_IDLE_TRIMMED_S = 100× (clamped to MAX).
    const targetSpeed = Math.max(IDLE_MIN_SPEED, idleDur / MAX_IDLE_TRIMMED_S);
    const speed = Math.min(IDLE_MAX_SPEED, targetSpeed);
    const trimmedDur = Math.max(0.05, idleDur / speed);
    return {
      rawStartS: idleStart, rawEndS: idleEnd, speed,
      trimmedStartS: trimmedCursor, trimmedEndS: trimmedCursor + trimmedDur,
    };
  };

  // Empty case: no anchors at all — likely an aborted run with nothing
  // to highlight. Crush the whole thing into one fast-forward block
  // bounded by MAX_IDLE_TRIMMED_S so we don't ship a 60s blank.
  if (windows.length === 0) {
    const seg = compressIdle(0, rawDurS, 0);
    return [seg];
  }

  const active: ActiveWindow[] = windows
    .map((w) => ({ start: Math.max(0, w.start), end: Math.min(rawDurS, w.end) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);

  // Merge windows that overlap or sit within TRIM_MERGE_S of each other
  // — collapses anchor clusters (click → snapshot 200ms later) into a
  // single segment. Drops segment count significantly, which speeds up
  // both the per-segment encode loop and the final concat.
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
  for (const w of merged) {
    if (w.start > cursor) {
      const idleSeg = compressIdle(cursor, w.start, trimmedCursor);
      segments.push(idleSeg);
      trimmedCursor = idleSeg.trimmedEndS;
    }
    const activeDur = w.end - w.start;
    segments.push({
      rawStartS: w.start, rawEndS: w.end, speed: 1.0,
      trimmedStartS: trimmedCursor, trimmedEndS: trimmedCursor + activeDur,
    });
    trimmedCursor += activeDur;
    cursor = w.end;
  }
  if (cursor < rawDurS) {
    const tailSeg = compressIdle(cursor, rawDurS, trimmedCursor);
    segments.push(tailSeg);
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
  /** The LLM-synthesised outro checklist used in the video — exposed so
   *  the PR-comment poster can render the same table in Markdown and so
   *  the web viewer can render it natively in the drawer. */
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
  console.log(chalk.dim(`  raw: ${rawDurS.toFixed(1)}s @ ${artifacts.plan.viewport?.width ?? 1280}×${artifacts.plan.viewport?.height ?? 800}`));

  const viewport = artifacts.plan.viewport ?? { width: 1280, height: 800 };
  const ttsBackend: TTSBackend = resolveBackend(voice, artifacts.plan.name);
  console.log(chalk.dim(`  voice-over: ${describeBackend(ttsBackend)}`));

  // ── 2. Compute raw ANCHORS from three sources:
  //      a) Mouse + keystroke interactions — gold-standard "user did
  //         something" signal, captured at 30Hz inside the page itself.
  //      b) HIGH-class tool calls (browser_click/type/navigate/etc) —
  //         the agent's actual interactions. LOW-class tools (snapshot,
  //         evaluate, wait_for) DO NOT anchor 1× windows; the page is
  //         static during those, so anchoring them just kept dead air.
  //      c) ffmpeg-detected scenechanges — catches async UI updates that
  //         neither the agent nor a click triggered: skeleton → content
  //         swaps, dialogs opening, route transitions, badges flashing in.
  //
  //      Every anchor brings KEEP_BEFORE_MS of lead-in and KEEP_AFTER_MS
  //      of follow-through; the editor merges overlaps, keeps active
  //      stretches at 1×, and crushes the gaps. Nothing visually
  //      interesting is lost — we just compress provably-static dead air.
  type Anchor = { tRaw: number; src: string };
  const anchors: Anchor[] = [];
  if (artifacts.interactions?.length) {
    for (const it of artifacts.interactions) {
      if (it.kind === "click" || it.kind === "key") {
        anchors.push({ tRaw: it.ts / 1000, src: it.kind });
      }
    }
  }
  if (artifacts.toolWindows?.length) {
    for (const tw of artifacts.toolWindows) {
      if (anchorClass(tw.kind) !== "high") continue;
      anchors.push({ tRaw: tw.startMs / 1000, src: tw.kind });
    }
  }
  // ffmpeg scenechange pass — independent of the agent's tool stream, so
  // it catches things the agent was passive for (a skeleton → content
  // transition the page made on its own). Failure is benign; we
  // continue with interaction + tool anchors only.
  console.log(chalk.dim(`  detecting scenechanges (threshold=${SCENECHANGE_THRESHOLD})…`));
  const sceneChanges = await detectScenechanges(stagedRaw, SCENECHANGE_THRESHOLD).catch(() => [] as number[]);
  for (const t of sceneChanges) anchors.push({ tRaw: t, src: "scenechange" });
  anchors.sort((a, b) => a.tRaw - b.tRaw);

  // Fallback: zero anchors (no interactions, no high tools, no scenechanges)
  // — this is unusual (probably an aborted goal) but we need to anchor
  // something so the run shows the page rather than pure fast-forward.
  // Use the goal intent events as last-resort anchors.
  if (anchors.length === 0) {
    for (const ev of artifacts.events) {
      if (ev.kind === "intent") anchors.push({ tRaw: ev.startMs / 1000, src: "intent-fallback" });
    }
  }

  const keepBeforeS = KEEP_BEFORE_MS / 1000;
  const keepAfterS = KEEP_AFTER_MS / 1000;
  const rawWindows: ActiveWindow[] = anchors.map((a) => ({
    start: Math.max(0, a.tRaw - keepBeforeS),
    end: Math.min(rawDurS, a.tRaw + keepAfterS),
  }));

  const anchorBreakdown: Record<string, number> = {};
  for (const a of anchors) anchorBreakdown[a.src] = (anchorBreakdown[a.src] ?? 0) + 1;
  const breakdownStr = Object.entries(anchorBreakdown).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(chalk.dim(`  anchors: ${anchors.length} (${breakdownStr || "(none)"})`));

  // ── 3. Build trim plan + render master. After this we know `masterDurS`.
  const plan = buildTrimPlan(rawDurS, rawWindows);
  const masterMp4Rel = "master.mp4";
  const masterMp4 = path.join(publicDir, masterMp4Rel);
  // Stats so the operator can see what the compressor did.
  let idleRaw = 0, idleTrimmed = 0, activeKept = 0, maxIdleSpeed = 1;
  for (const seg of plan) {
    const rawDur = seg.rawEndS - seg.rawStartS;
    const trimDur = seg.trimmedEndS - seg.trimmedStartS;
    if (seg.speed > 1.01) {
      idleRaw += rawDur; idleTrimmed += trimDur;
      if (seg.speed > maxIdleSpeed) maxIdleSpeed = seg.speed;
    } else {
      activeKept += rawDur;
    }
  }
  console.log(chalk.dim(`  trim plan: ${plan.length} segments · ${activeKept.toFixed(1)}s active @ 1× kept · ${idleRaw.toFixed(1)}s idle → ${idleTrimmed.toFixed(1)}s (max ${maxIdleSpeed.toFixed(1)}×)`));
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

  // Ensure first body moment starts at 0 — otherwise the opening seconds
  // of the master have no chunk and would render silent.
  const bodyMoments: BodyMoment[] = [];
  if (bodyMomentsRaw.length === 0) {
    bodyMoments.push({ startS: 0, visibility: "visible", toolKind: "intro-cover" });
  } else {
    if (bodyMomentsRaw[0].startS > 0.4) {
      bodyMoments.push({ ...bodyMomentsRaw[0], startS: 0 });
      for (let i = 1; i < bodyMomentsRaw.length; i++) bodyMoments.push(bodyMomentsRaw[i]);
    } else {
      bodyMoments.push(...bodyMomentsRaw);
      bodyMoments[0] = { ...bodyMoments[0], startS: 0 };
    }
  }

  // Coalesce moments closer than MIN_CHUNK_S into the previous one — keeps
  // the narrator from having to write a 4-word filler line.
  let coalesced: BodyMoment[] = [];
  for (const m of bodyMoments) {
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

  // Compose the full scene list (intro + body + outro) with composition
  // timeline start times, then compute targetDurS = gap to next scene.
  const sceneList: NarrationScene[] = [];
  sceneList.push({
    id: "intro", kind: "intro", visibility: "intro",
    startS: 0, targetDurS: INTRO_TARGET_S,
    context: `Title card. Open by naming the PROBLEM the PR addresses, then preview what we'll see in the next ${(masterDurS).toFixed(0)}s of screen recording.`,
  });
  for (let i = 0; i < coalesced.length; i++) {
    const m = coalesced[i];
    const composedStart = INTRO_TARGET_S + m.startS;
    sceneList.push({
      id: `m-${i}`, kind: "moment", visibility: m.visibility,
      startS: composedStart, targetDurS: 0, // filled below
      context: m.visibility === "silent"
        ? `The screen is briefly static while the agent investigates with ${m.toolKind}. Narrate the WHY (what we're looking for, what should happen next).`
        : `On-screen: the agent is performing ${m.toolKind}. Narrate the INTENT and what we should see appear.`,
      toolKind: m.toolKind,
      toolInput: m.toolInput,
      toolResult: m.toolResult,
    });
  }
  sceneList.push({
    id: "outro", kind: "outro", visibility: "outro",
    startS: INTRO_TARGET_S + masterDurS, targetDurS: OUTRO_TARGET_S,
    context: "Closing card. ONE sentence asking for input or naming an open question. Don't summarize what was shown.",
  });

  // Fill targetDurS from gaps. Intro/outro keep their fixed targets.
  for (let i = 0; i < sceneList.length - 1; i++) {
    if (sceneList[i].kind === "moment") {
      const gap = sceneList[i + 1].startS - sceneList[i].startS;
      sceneList[i].targetDurS = Math.max(MIN_CHUNK_S, Math.min(14, gap));
    }
  }

  // ── 5. Single Claude call → coherent narration sized to scene targets.
  //      Kick off the checklist Claude call in parallel — it doesn't depend
  //      on narration so we don't pay its latency twice. Skip when the caller
  //      already synthesised the checklist for us (e.g. the `run` CLI command
  //      now generates + prints it before deciding whether to render a video).
  const checklistPromise: Promise<ChecklistItem[] | null> =
    precomputedChecklist !== undefined
      ? Promise.resolve(precomputedChecklist)
      : generateChecklist({ artifacts, prTitle, prBody });
  const narration = await generateTimedNarration({
    plan: artifacts.plan, prTitle, prBody, focus,
    scenes: sceneList,
  });

  // ── 6. TTS every chunk in parallel (intro + body + outro). One bounded pool.
  const tts = await runWithConcurrency(sceneList, 6, async (s, i) => {
    const text = narration.chunks[i].text;
    if (!ttsBackend || !text.trim()) return { src: undefined as string | undefined, dur: 0 };
    const fileName = `voice-${String(i).padStart(3, "0")}.wav`;
    try {
      await synth(ttsBackend, sanitiseForSpeech(text), path.join(publicDir, fileName));
      return { src: fileName, dur: await ffprobeDuration(path.join(publicDir, fileName)) };
    } catch (e) {
      console.log(chalk.yellow(`  voice skipped for scene ${s.id}: ${(e as Error).message.split("\n")[0]}`));
      return { src: undefined, dur: 0 };
    }
  });

  // ── 7. Convert intro + body + outro into renderable shapes. Each body
  //      chunk gets a playback rate that fits its voice into its window;
  //      intro/outro stretch their Sequence to fit the voice.
  const introTts = tts[0];
  const outroTts = tts[tts.length - 1];
  const bodyChunks: BodyChunk[] = [];
  for (let i = 1; i < sceneList.length - 1; i++) {
    const s = sceneList[i];
    const c = narration.chunks[i];
    const v = tts[i];
    const next = sceneList[i + 1];
    const durS = next.startS - s.startS; // composition gap = body gap (intro offset cancels)
    let rate = 1;
    if (v.dur > 0) {
      // Aim to fit within the slot minus a small tail so the next chunk's
      // first word never collides with the trailing breath. Wide range:
      // 0.85x stretches a short line to fill ~15% more wall-clock without
      // sounding distorted; 1.6x lets us fit an over-eager narrator into
      // a tight slot rather than dropping into the next chunk.
      const targetSpeechS = Math.max(0.5, durS - 0.08);
      rate = Math.max(0.85, Math.min(1.6, v.dur / targetSpeechS));
    }
    bodyChunks.push({
      startS: s.startS - INTRO_TARGET_S, // back to body-relative
      durS,
      text: sanitiseForSpeech(c.captionText),
      voiceSrc: v.src,
      voiceDurS: v.dur || undefined,
      voicePlaybackRate: rate,
      badgeLabel: s.visibility === "silent" ? c.badgeLabel?.trim() || undefined : undefined,
      badgeDetail: s.visibility === "silent" ? c.badgeDetail?.trim() || undefined : undefined,
    });
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

  // Outro checklist. PREFERRED: the Claude-generated 6-12 row list
  // (synthesised from goals + agent action history — that's what the
  // reviewer actually wants to see). FALLBACK: one row per goal, if
  // generateChecklist returned null (transient CLI failure / unparseable
  // output) — we never want to ship an outro with no checklist at all.
  let checklist: ChecklistItem[] = [];
  const llmList = await checklistPromise;
  if (llmList && llmList.length > 0) {
    checklist = llmList;
    console.log(chalk.dim(`  checklist: ${llmList.length} llm-synthesised items`));
  } else {
    const goalEvents = artifacts.events.filter((e) => e.kind === "intent");
    const ranked = [...goalEvents].sort((a, b) => {
      const aFail = a.outcome === "failure" ? 0 : 1;
      const bFail = b.outcome === "failure" ? 0 : 1;
      return aFail - bFail;
    });
    checklist = ranked.slice(0, 6).map((e) => ({
      outcome: e.outcome,
      label: (e.shortLabel ?? e.description).replace(/\s+/g, " ").slice(0, 36).trim(),
      note: e.shortNote?.replace(/\s+/g, " ").slice(0, 64).trim() || undefined,
    }));
    console.log(chalk.dim(`  checklist: ${checklist.length} fallback goal-level items`));
  }

  // Map raw-video-ms interactions onto the master timeline. Interactions
  // that landed in a trimmed-out gap get filtered out (rawToTrimmed has no
  // way to signal that, so we walk the trim plan ourselves). `key` events
  // get coerced to the most recent move position so they still anchor a
  // ToolBadge in the right spot, even though they don't need a cursor flash.
  const mappedInteractions: SingleVideoInput["interactions"] = [];
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
      mappedInteractions.push({ ts: Math.max(0, Math.round(mappedS * 1000)), kind: ev.kind, x: ev.x, y: ev.y, key: ev.key });
    }
    console.log(chalk.dim(`  interactions: ${mappedInteractions.length}/${artifacts.interactions.length} kept after trim mapping`));
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
    introCaption: sanitiseForSpeech(narration.chunks[0].captionText),
    outroVoiceSrc: outroTts.src,
    outroVoiceDurS: outroTts.dur || undefined,
    outroVoicePlaybackRate: outroPlaybackRate,
    outroCaption: sanitiseForSpeech(narration.chunks[narration.chunks.length - 1].captionText),
    versionTag: getVersionTag(),
    bodyChunks,
    interactions: mappedInteractions.length > 0 ? mappedInteractions : undefined,
    checklist: checklist.length > 0 ? checklist : undefined,
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
