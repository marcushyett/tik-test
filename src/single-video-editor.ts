import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
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
  versionTag?: string;
  /** Per-tool-call overlays in TRIMMED seconds — rendered as small status
   *  cards during silent-but-informative tool calls (browser_evaluate,
   *  browser_network_requests, etc). Each has a user-friendly label so
   *  viewers see what the agent is checking and why. */
  toolOverlays?: Array<{ startS: number; endS: number; label: string; detail?: string; voiceSrc?: string; voiceDurS?: number; captionText?: string }>;
}

/**
 * Run an async worker over `items` with at most `limit` in flight. Preserves
 * the input order in the result array (so per-step voice indexes stay aligned
 * with their events). Used to parallelize OpenAI TTS calls without hammering
 * the endpoint beyond what a single API key comfortably sustains.
 */
/**
 * Classify a tool kind for the video:
 *   "silent"  — investigative work with no visible UI change (evaluate,
 *               network_requests). Gets an overlay BADGE + voice.
 *   "visible" — user-visible interaction (click, type, press, nav). Gets
 *               voice ONLY (viewer can see what's happening, badge would
 *               clutter the frame).
 *   "skip"    — plumbing the viewer shouldn't care about.
 * Both "silent" and "visible" tool calls get a TTS voice line so the
 * narration is continuous across the video instead of one line per goal.
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
 * Call claude once per run to turn a batch of raw tool calls into short,
 * specific, non-technical "Looking for X → Found Y" captions. One CLI
 * round-trip amortized across all overlays instead of per-tool.
 */
async function translateToolCaptions(
  calls: Array<{ kind: string; input?: string; result?: string }>,
): Promise<Array<{ label: string; detail?: string } | null>> {
  if (calls.length === 0) return [];
  const lines = calls.map((c, i) => {
    const input = (c.input || "").replace(/\s+/g, " ").slice(0, 250);
    const result = (c.result || "").replace(/\s+/g, " ").slice(0, 400);
    return `#${i + 1} [${c.kind}] input="${input}" result="${result}"`;
  }).join("\n");
  const prompt = `You are narrating what a QA agent is checking inside a web app during a review video, for a non-technical viewer.

For each tool call below, produce ONE JSON object {"label":"...","detail":"..."} on its own line, where:
- label: 4-8 words, present tense, what the agent is LOOKING FOR. No jargon (no "JS", "DOM", "API", "HTTP"). Good: "Counting broken TikTok thumbnails". Bad: "Running JS evaluation".
- detail: 4-12 words, what the agent FOUND. Include specific numbers from the result if visible. Good: "Found 84 expired image URLs, 0 blob-backed". Bad: "Various things".

Return exactly ${calls.length} JSON objects, one per line, in the same order. No prose, no markdown, no numbering prefix. Just the JSON lines.

Tool calls:
${lines}`;

  const { spawn } = await import("node:child_process");
  return await new Promise<Array<{ label: string; detail?: string } | null>>((resolve) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "text", "--model", "sonnet"], {
      stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp",
    });
    let out = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(calls.map(() => null)); }, 60_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      const results: Array<{ label: string; detail?: string } | null> = [];
      const trimmed = out.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "");
      for (const raw of trimmed.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (typeof obj?.label === "string") {
            results.push({ label: obj.label.slice(0, 80), detail: typeof obj.detail === "string" && obj.detail.trim() ? obj.detail.slice(0, 120) : undefined });
          } else results.push(null);
        } catch { results.push(null); }
      }
      while (results.length < calls.length) results.push(null);
      resolve(results.slice(0, calls.length));
    });
    child.on("error", () => { clearTimeout(timer); resolve(calls.map(() => null)); });
  });
}

/**
 * Extract a short non-technical detail line from a tool result. Uses
 * cheap pattern-matching heuristics rather than an LLM call — good enough
 * for common evaluate/network shapes, silent otherwise.
 *
 *   browser_evaluate with {total, blob, broken} → "18 of 21 thumbnails from Blob, 0 broken"
 *   browser_network_requests with many 403s     → "Spotted 84 failing image loads"
 *   browser_network_requests otherwise         → "Watched N requests"
 *   browser_take_screenshot                     → silent (label alone)
 */
function toolDetail(kind: string, result?: string): string | undefined {
  if (!result) return undefined;
  const trimmed = result.trim();
  if (kind === "browser_evaluate") {
    // Look for a JSON object in the result text — MCP prefixes with "### Result {...}".
    const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
    if (!jsonMatch) return undefined;
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const flat = flattenForSummary(obj);
      // Common thumbnail/image shapes.
      if (typeof flat.total === "number" && typeof flat.blob === "number") {
        const blobN = flat.blob;
        const total = flat.total;
        const broken = flat.broken ?? flat.tiktokCdn ?? 0;
        if (total === 0) return "Grid looks empty";
        if (blobN === total && !broken) return `All ${total} thumbnails loaded cleanly`;
        if (blobN === 0) return `None of ${total} images loaded from Blob storage`;
        return `${blobN} of ${total} thumbnails from Blob${broken ? `, ${broken} broken` : ""}`;
      }
      if (typeof flat.loaded === "number" && typeof flat.broken === "number") {
        return `${flat.loaded} loaded, ${flat.broken} broken`;
      }
      if (typeof flat.count === "number") return `Counted ${flat.count}`;
      return undefined;
    } catch { return undefined; }
  }
  if (kind === "browser_network_requests") {
    const failing = (trimmed.match(/\] [34][0-9]{2}\b/g) || []).length;
    const total = (trimmed.match(/^\[(GET|POST|PUT|DELETE|PATCH)\]/gm) || []).length;
    if (failing > 0) return `Spotted ${failing} failing request${failing === 1 ? "" : "s"}`;
    if (total > 0) return `Watched ${total} requests`;
    return undefined;
  }
  return undefined;
}

/**
 * Recursively find numeric leaves at depth ≤2 and merge into a flat map.
 * Handles shapes like `{counts: {total: 4, blob: 0}}` and `{total: 4, blob: 0}`.
 */
function flattenForSummary(obj: any, depth = 2): Record<string, any> {
  if (obj == null || typeof obj !== "object") return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" || typeof v === "string") out[k] = v;
    else if (depth > 0 && typeof v === "object") Object.assign(out, flattenForSummary(v, depth - 1));
  }
  return out;
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
  let isFirstIdle = true;
  for (const w of merged) {
    const idleBefore = w.start - cursor;
    if (idleBefore > idleThresholdS) {
      // First idle (page load / auth / setup) gets a longer cap so the
      // opening reads naturally — users complained the opening was too
      // fast to follow. Subsequent idle (agent thinking between tool
      // calls) compresses harder to avoid static dead time.
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
    isFirstIdle = false;
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

  const stepsMap = new Map<string, PlanStep>(((artifacts.plan.steps ?? artifacts.plan.goals ?? []) as any).map((s: any) => [s.id, s]));
  const viewport = artifacts.plan.viewport ?? { width: 1280, height: 800 };
  // Seed voice variation from the plan name (so two renders of the same PR
  // keep the same voice, but different PRs alternate across the feed).
  const ttsBackend: TTSBackend = resolveBackend(voice, artifacts.plan.name);
  console.log(chalk.dim(`  voice-over: ${describeBackend(ttsBackend)}`));

  // 2. Visible events.
  // `navigate` is intentionally boring: the raw video always opens with a blank
  // page-load frame and a slow hydration, and narrating "opening the preview"
  // wastes the first 3-5 seconds. Treating navigate as idle lets the trim plan
  // collapse everything before the first real interaction to ~0.6s.
  const BORING_KINDS = new Set(["script", "wait", "navigate"]);
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
  //    TTS is the classic "15 sequential network calls that don't depend on each
  //    other" trap — we run them concurrently (bounded pool) so this stage
  //    stops being 25s of twiddling thumbs per PR. OpenAI's speech endpoint is
  //    happy with ~6 parallel requests.
  interface PreEvent {
    ev: StepEvent;
    voiceLine: string;
    caption: string;
    voiceSrc?: string;
    voiceDurS: number;
  }
  const preStaged = visibleEvents.map((ev, i) => {
    const step = stepsMap.get(ev.stepId) ?? ({} as PlanStep);
    const tpl = narrate({
      step: { ...step, id: ev.stepId, kind: ev.kind, description: ev.description, importance: ev.importance } as PlanStep,
      outcome: ev.outcome, error: ev.error, notes: ev.notes,
      index: i, total: visibleEvents.length, startUrl: artifacts.plan.startUrl,
    });
    const storied = story?.steps[i];
    const voiceLine = (storied?.voiceLine || tpl.voiceLine).trim();
    const caption = (storied?.captionText || tpl.captionText).trim();
    return { i, ev, voiceLine, caption };
  });

  const preEvents: PreEvent[] = await runWithConcurrency(preStaged, 6, async ({ i, ev, voiceLine, caption }): Promise<PreEvent> => {
    if (!ttsBackend) return { ev, voiceLine, caption, voiceSrc: undefined, voiceDurS: 0 };
    const fileName = `voice-${String(i).padStart(3, "0")}.wav`;
    try {
      await synth(ttsBackend, sanitiseForSpeech(voiceLine), path.join(publicDir, fileName));
      const voiceDurS = await ffprobeDuration(path.join(publicDir, fileName));
      return { ev, voiceLine, caption, voiceSrc: fileName, voiceDurS };
    } catch (e) {
      console.log(chalk.yellow(`  voice skipped for step ${i}: ${(e as Error).message.split("\n")[0]}`));
      return { ev, voiceLine, caption, voiceSrc: undefined, voiceDurS: 0 };
    }
  });

  // 5. Compute each event's raw-video active window — at least long enough for the voice line.
  // The window starts where the event begins (minus a 0.1s lead-in) and ends at max(natural end, start + voice + 0.25 tail).
  // Overlapping windows get merged so each event's audio has exclusive runway.
  const rawWindows: ActiveWindow[] = [];
  const preferredWindows: Array<{ start: number; end: number; voiceDurS: number }> = [];
  // Skip event-level windows for goal-based runs ("intent" kind): those span
  // the whole goal (often 90s+), swallowing the per-tool-call micro-windows
  // so nothing inside the goal gets trimmed. Use tool windows alone instead.
  const hasToolWindows = !!(artifacts.toolWindows && artifacts.toolWindows.length > 0);
  for (let i = 0; i < preEvents.length; i++) {
    const { ev, voiceDurS } = preEvents[i];
    if (hasToolWindows && ev.kind === "intent") continue;
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
  // Add per-tool-call micro-windows so the trimmer compresses agent-thinking
  // lulls WITHIN a goal event. Without these, a single 90s goal event is one
  // big "active" window and nothing inside gets trimmed.
  if (artifacts.toolWindows && artifacts.toolWindows.length > 0) {
    for (const tw of artifacts.toolWindows) {
      const s = Math.max(0, Math.min(rawDurS, tw.startMs / 1000));
      const e = Math.max(s + 0.2, Math.min(rawDurS, tw.endMs / 1000));
      rawWindows.push({ start: s, end: e });
    }
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
    // Intro + outro can synth in parallel (they're independent).
    const [introResult, outroResult] = await Promise.all([
      (async () => {
        try {
          await synth(ttsBackend, sanitiseForSpeech(introLine), path.join(publicDir, "intro.wav"));
          return { src: "intro.wav", dur: await ffprobeDuration(path.join(publicDir, "intro.wav")) };
        } catch { return null; }
      })(),
      (async () => {
        try {
          await synth(ttsBackend, sanitiseForSpeech(outroLine), path.join(publicDir, "outro.wav"));
          return { src: "outro.wav", dur: await ffprobeDuration(path.join(publicDir, "outro.wav")) };
        } catch { return null; }
      })(),
    ]);
    if (introResult) { introVoiceSrc = introResult.src; introVoiceDurS = introResult.dur; }
    if (outroResult) { outroVoiceSrc = outroResult.src; outroVoiceDurS = outroResult.dur; }
  }

  const introDurFrames = Math.max(Math.round(FPS * 3.4), Math.round((introVoiceDurS + 0.6) * FPS));
  const outroDurFrames = Math.max(Math.round(FPS * 3.2), Math.round((outroVoiceDurS + 0.6) * FPS));

  // Build overlays that explain what the agent is doing during silent tool
  // calls. Mapping: tool-window raw time → trimmed time via the trim plan
  // (plus intro offset the composition adds). Skip kinds that are either
  // user-visible already (click, navigate, scroll, press) or internal
  // plumbing (ToolSearch, Read, Glob). The remaining tools get a friendly
  // caption so a viewer understands why the screen appears still.
  const toolOverlays: NonNullable<SingleVideoInput["toolOverlays"]> = [];
  if (artifacts.toolWindows?.length) {
    // Map raw→trimmed using the trim plan built earlier in this function.
    const toTrimmed = (rawS: number): number => {
      for (const seg of plan) {
        if (rawS >= seg.rawStartS && rawS <= seg.rawEndS + 0.001) {
          const fracRaw = (rawS - seg.rawStartS) / Math.max(0.001, seg.rawEndS - seg.rawStartS);
          return seg.trimmedStartS + fracRaw * (seg.trimmedEndS - seg.trimmedStartS);
        }
      }
      return masterDurS;
    };
    // Pick every tool call worth narrating. Silent tools additionally get
    // an on-screen BADGE; visible tools (clicks, typing, nav) are shown in
    // the browser recording, but we still voice them so there's continuous
    // narration over the video instead of a single voice line per goal.
    const surfacing = artifacts.toolWindows
      .map((tw, idx) => ({ tw, idx, kind: classifyTool(tw.kind) as "silent" | "visible" | "skip" }))
      .filter((x) => x.kind !== "skip");
    let captions: Array<{ label: string; detail?: string } | null> = [];
    if (surfacing.length > 0) {
      console.log(chalk.dim(`  narrating ${surfacing.length} tool moments…`));
      captions = await translateToolCaptions(surfacing.map((x) => x.tw));
    }
    // Stage per-tool entries. Silent tools keep their overlay badge (label
    // shown on top of the frame); visible tools get VOICE ONLY so the
    // caption doesn't fight the user-visible action on screen.
    const staged: Array<{ startS: number; endS: number; label: string; detail?: string; kind: "silent" | "visible"; idx: number }> = [];
    for (let i = 0; i < surfacing.length; i++) {
      const s = surfacing[i];
      const caption = captions[i];
      if (!caption?.label) continue;
      const sTrim = toTrimmed(s.tw.startMs / 1000);
      const eTrim = Math.max(sTrim + 0.4, toTrimmed(s.tw.endMs / 1000));
      if (eTrim - sTrim < 0.3) continue;
      staged.push({ startS: sTrim, endS: eTrim, label: caption.label, detail: caption.detail, kind: s.kind as "silent" | "visible", idx: i });
    }
    if (ttsBackend && staged.length > 0) {
      console.log(chalk.dim(`  voicing ${staged.length} tool moments…`));
      await runWithConcurrency(staged, 4, async (ov, i) => {
        const line = ov.detail ? `${ov.label}. ${ov.detail}.` : `${ov.label}.`;
        const fileName = `overlay-${i}.wav`;
        try {
          await synth(ttsBackend, sanitiseForSpeech(line), path.join(publicDir, fileName));
          const dur = await ffprobeDuration(path.join(publicDir, fileName));
          toolOverlays.push({
            startS: ov.startS, endS: ov.endS,
            // Silent tools: badge with label/detail on top of frame.
            // Visible tools: no badge (viewer sees the action already).
            label: ov.kind === "silent" ? ov.label : "",
            detail: ov.kind === "silent" ? ov.detail : undefined,
            // Both kinds get captionText so the voice is always subtitled.
            captionText: line,
            voiceSrc: fileName, voiceDurS: dur,
          });
        } catch {
          if (ov.kind === "silent") {
            toolOverlays.push({ startS: ov.startS, endS: ov.endS, label: ov.label, detail: ov.detail });
          }
        }
      });
    } else {
      for (const ov of staged) {
        if (ov.kind === "silent") toolOverlays.push({ startS: ov.startS, endS: ov.endS, label: ov.label, detail: ov.detail });
      }
    }
    toolOverlays.sort((a, b) => a.startS - b.startS);
  }

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
    versionTag: getVersionTag(),
    toolOverlays: toolOverlays.length > 0 ? toolOverlays : undefined,
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

  // Segment parallelism: split composition into N processes, render in
  // parallel via frameRange, concat with ffmpeg. Remotion's own `concurrency`
  // only parallelizes tabs in one process — segments parallelize ACROSS
  // processes so render + encode of different parts overlap.
  const totalFrames = composition.durationInFrames;
  const segmentsCfg = Math.max(1, Math.min(4, Number(process.env.TIK_RENDER_SEGMENTS) || 3));
  const segments = totalFrames < 240 ? 1 : segmentsCfg;
  const perSegConcurrency = Math.max(2, Math.min(
    Number(process.env.TIK_RENDER_CONCURRENCY) || 8,
    Math.floor(os.cpus().length / Math.max(1, segments)),
  ));
  const effectiveWidth = quick ? 540 : composition.width;
  const effectiveHeight = quick ? 960 : composition.height;
  console.log(chalk.dim(`  rendering ${totalFrames} frames (${(totalFrames / FPS).toFixed(1)}s) at ${effectiveWidth}×${effectiveHeight} — ${segments}× parallel segment${segments === 1 ? "" : "s"} · concurrency ${perSegConcurrency}…`));

  const videoBitrate = (quick ? "1200k" : "6000k") as `${number}k`;
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
    jpegQuality: quick ? 70 : 88,
    chromiumOptions: { gl: glBackend },
    offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
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
