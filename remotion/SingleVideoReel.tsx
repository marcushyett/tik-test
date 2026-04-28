import { AbsoluteFill, Audio, Easing, Sequence, interpolate, useCurrentFrame, useVideoConfig, staticFile } from "remotion";
import { Video } from "@remotion/media";
import { Background } from "./components/Background";
import { Intro } from "./components/Intro";
import { Outro } from "./components/Outro";
import { WordCaption } from "./components/WordCaption";
import { ToolBadge } from "./components/ToolBadge";

export interface BodyChunk {
  startS: number;
  durS: number;
  text: string;
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
  badgeLabel?: string;
  badgeDetail?: string;
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
  /** Body narration timeline. Sorted, non-overlapping, sums to masterDurS.
   *  Each chunk renders ONE Audio + ONE WordCaption Sequence + optional
   *  ToolBadge — guaranteed never to stack with siblings. */
  bodyChunks: BodyChunk[];
  /** Mouse + click stream (already mapped to master-timeline ms by the editor).
   *  `move` events drive the cursor overlay; `click` events drive both the
   *  cursor flash AND the targeted pan-zoom toward the click bbox. Coords are
   *  in VIEWPORT (page) pixels — Remotion maps them to canvas pixels via the
   *  recording's objectFit:contain math. */
  interactions?: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>;
  checklist?: Array<{ outcome: "success" | "failure" | "skipped"; label: string; note?: string }>;
}

export function computeSingleVideoDuration(input: SingleVideoInput, fps: number): number {
  const masterFrames = Math.round(input.masterDurS * fps);
  return input.introDurFrames + masterFrames + input.outroDurFrames;
}

/**
 * SAFE-AREA RULES — read this before adding ANY new on-screen element.
 *
 * The rendered video is 9:16 and plays full-bleed inside the tik-test web
 * viewer (and inside Slack / Twitter / iOS native players). The viewer
 * overlays its own UI ON TOP of the video so it doesn't push the video
 * down — meaning these zones of the rendered frame may be partially
 * covered by player chrome at any moment:
 *
 *   - TOP 0..120px        viewer header bar ("All repos" + repo title)
 *                          plus iOS / Android browser status bar.
 *   - BOTTOM 0..130px     OUR progress bar, mute button, mobile drawer
 *                          peek pill, iOS home indicator, embedded-player
 *                          native controls.
 *   - BOTTOM 130..240px   caption band (paginated WordCaption renders here
 *                          — only captions, no other content).
 *   - TOP-RIGHT 120×120   version badge (see VersionBadge below).
 *
 * Hard rule: NO main content (titles, stats, body badges, lists) in any
 * of those zones. Use the middle band (top ~120 → bottom ~240). Captions
 * are the ONE exception that lives in the bottom safe band.
 */

export const SingleVideoReel: React.FC<SingleVideoInput> = (props) => {
  const { fps } = useVideoConfig();
  const masterFrames = Math.round(props.masterDurS * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: "#07080c" }}>
      {/* Intro */}
      <Sequence from={0} durationInFrames={props.introDurFrames} layout="none">
        <Intro
          title={props.title}
          summary={props.summary}
          stats={props.stats}
          voiceSrc={props.introVoiceSrc}
          voiceDurS={props.introVoiceDurS}
          voicePlaybackRate={props.introVoicePlaybackRate}
          captionText={props.introCaption}
        />
      </Sequence>

      {/* Body — full trimmed recording with back-to-back narration chunks. */}
      <Sequence from={props.introDurFrames} durationInFrames={masterFrames} layout="none">
        <SingleVideoBody input={props} />
      </Sequence>

      {/* Outro */}
      <Sequence from={props.introDurFrames + masterFrames} durationInFrames={props.outroDurFrames} layout="none">
        <Outro
          title={props.title}
          stats={props.stats}
          checklist={props.checklist}
          voiceSrc={props.outroVoiceSrc}
          voiceDurS={props.outroVoiceDurS}
          voicePlaybackRate={props.outroVoicePlaybackRate}
          captionText={props.outroCaption}
        />
      </Sequence>

      {props.versionTag && <VersionBadge tag={props.versionTag} />}
    </AbsoluteFill>
  );
};

const VersionBadge: React.FC<{ tag: string }> = ({ tag }) => (
  <div
    style={{
      position: "absolute",
      top: 28,
      right: 28,
      padding: "8px 14px",
      borderRadius: 999,
      background: "rgba(10, 12, 18, 0.78)",
      color: "rgba(255,255,255,0.92)",
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      fontSize: 22,
      fontWeight: 600,
      letterSpacing: "0.08em",
      border: "1px solid rgba(255,255,255,0.14)",
      pointerEvents: "none",
      zIndex: 2000,
    }}
  >
    {tag}
  </div>
);

const SingleVideoBody: React.FC<{ input: SingleVideoInput }> = ({ input }) => {
  const { fps, width: canvasW, height: canvasH } = useVideoConfig();
  const frame = useCurrentFrame();
  const timeS = frame / fps;

  // Recording → canvas mapping (objectFit: contain). Pure function of the
  // viewport size and canvas size; computed once per render.
  const vw = input.viewport.width;
  const vh = input.viewport.height;
  const fitScale = Math.min(canvasW / vw, canvasH / vh);
  const fitW = vw * fitScale;
  const fitH = vh * fitScale;
  const offsetX = (canvasW - fitW) / 2;
  const offsetY = (canvasH - fitH) / 2;
  const toCanvas = (x: number, y: number) => ({
    cx: offsetX + x * fitScale,
    cy: offsetY + y * fitScale,
  });

  const interactions = input.interactions ?? [];
  const clicks = interactions.filter((i) => i.kind === "click");

  // Cursor path — click-to-click travel with ease-out. Playwright MCP
  // emits very few raw mousemove events (its locator.click() hits the
  // target without painting an intermediate trail), so interpolating
  // between sparse moves leaves the cursor crawling. Instead we drive
  // the cursor purely off click positions: it sits on the previous
  // click, then glides over to the next one in TRAVEL_S before that
  // click's flash fires. Result: human-paced motion with the cursor
  // ALWAYS arriving exactly where the page is about to be tapped.
  const TRAVEL_S = 0.55;
  let cursorVx = vw / 2;
  let cursorVy = vh / 2;
  if (clicks.length > 0) {
    // Default — before the first click, sit at the first click's spot
    cursorVx = clicks[0].x;
    cursorVy = clicks[0].y;
    for (let i = 0; i < clicks.length; i++) {
      const tc = clicks[i].ts / 1000;
      if (timeS >= tc) {
        cursorVx = clicks[i].x;
        cursorVy = clicks[i].y;
        continue;
      }
      // We are between clicks[i-1] and clicks[i] (or before the first)
      const prev = i > 0 ? clicks[i - 1] : clicks[i];
      const travelStart = Math.max((prev.ts / 1000) + 0.05, tc - TRAVEL_S);
      if (timeS <= travelStart) {
        cursorVx = prev.x;
        cursorVy = prev.y;
      } else {
        const span = Math.max(0.001, tc - travelStart);
        const tRaw = Math.min(1, Math.max(0, (timeS - travelStart) / span));
        const tEased = Easing.bezier(0.22, 1, 0.36, 1)(tRaw); // ease-out so the cursor decelerates onto the target
        cursorVx = prev.x + (clicks[i].x - prev.x) * tEased;
        cursorVy = prev.y + (clicks[i].y - prev.y) * tEased;
      }
      break;
    }
  }
  const cursor = toCanvas(cursorVx, cursorVy);

  // Targeted pan-zoom — always-on baseline + bell-curve punch-in on each
  // click. The recording's letterbox-fit footprint (page rendered at ~56%
  // of canvas height because of objectFit:contain on a wide viewport)
  // looks tiny without zoom, so we hold a 1.4× baseline that keeps the
  // page comfortably large the whole time. Each click rides on top of
  // that baseline up to a 2.0× peak (integer scale = sharper) for ~1.8s,
  // then eases back to the baseline. Densely-spaced clicks chain.
  const ZOOM_HALF_WINDOW_S = 0.9;
  const ZOOM_BASELINE = 1.4; // always-on
  const ZOOM_PEAK = 2.0;     // integer-scale peak — bilinear sampling lines up cleanly
  let bestWeight = 0;
  let bestClick: typeof clicks[number] | null = null;
  for (const c of clicks) {
    const dt = timeS - c.ts / 1000;
    // Slight lead so the camera is already on the element when the click
    // ripple fires (humans look at things before they click them).
    const centred = dt + 0.18;
    const w = Math.max(0, 1 - Math.abs(centred) / ZOOM_HALF_WINDOW_S);
    if (w > bestWeight) { bestWeight = w; bestClick = c; }
  }
  const eased = Easing.bezier(0.4, 0, 0.2, 1)(bestWeight);
  const zoomScale = ZOOM_BASELINE + (ZOOM_PEAK - ZOOM_BASELINE) * eased;
  // When no click is active, focus on the cursor so the always-on baseline
  // zoom keeps the user's attention on where the cursor will go next.
  const focus = bestClick
    ? toCanvas(bestClick.x, bestClick.y)
    : toCanvas(cursorVx, cursorVy);

  // Click flash — any click within ±0.18s gets a ring expansion centred on
  // the click point.
  const FLASH_HALF_S = 0.18;
  let flashAmount = 0;
  for (const c of clicks) {
    const dt = Math.abs(timeS - c.ts / 1000);
    if (dt < FLASH_HALF_S) {
      const local = 1 - dt / FLASH_HALF_S;
      if (local > flashAmount) flashAmount = local;
    }
  }

  return (
    <AbsoluteFill>
      <Background accent="#00e5a0" intensity={0.7} />

      {/* The trimmed master recording. The transform wrapper is always
          mounted because the baseline zoom is > 1 (the page would
          otherwise render too small inside the portrait canvas). Video
          + cursor share the same transform so they zoom together; the
          cursor SVG counter-scales to keep its on-screen size constant. */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0a0a0a" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `scale(${zoomScale})`,
            transformOrigin: `${focus.cx}px ${focus.cy}px`,
          }}
        >
          <Video
            src={staticFile(input.masterVideoSrc)}
            muted
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
          <CursorOverlay
            cx={cursor.cx}
            cy={cursor.cy}
            flashAmount={flashAmount}
            counterScale={1 / zoomScale}
          />
        </div>
      </div>

      {/* One Sequence per body chunk. Chunks are guaranteed non-overlapping
          by the editor, so at any frame at most one Audio + one WordCaption
          + at most one ToolBadge is mounted. No more caption stacking. */}
      {input.bodyChunks.map((c, i) => {
        const startFrame = Math.round(c.startS * fps);
        const durFrames = Math.max(1, Math.round(c.durS * fps));
        return (
          <Sequence key={`chunk-${i}`} from={startFrame} durationInFrames={durFrames} layout="none">
            {c.voiceSrc && (
              <Audio
                src={staticFile(c.voiceSrc)}
                volume={1.1}
                playbackRate={c.voicePlaybackRate ?? 1}
              />
            )}
            {c.badgeLabel && <ToolBadge label={c.badgeLabel} detail={c.badgeDetail} />}
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 240 }}>
              <WordCaption
                text={c.text}
                durationInFrames={durFrames}
                fps={fps}
                accent="#00e5a0"
                voiceDurS={c.voiceDurS ? c.voiceDurS / (c.voicePlaybackRate ?? 1) : undefined}
                voiceStartDelayS={0.05}
              />
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * Pointer + click flash drawn on top of the recording. Lives inside the
 * pan-zoom transform so the cursor tracks the zoomed page coordinates
 * exactly. The SVG counter-scales to keep its on-screen size constant as
 * the parent scales up/down. The pointer's tip (viewBox 3,2) is pinned
 * EXACTLY to (cx, cy) — without this the click ring lands a few pixels
 * off-target and the visual contract ("cursor is on the thing it clicks")
 * breaks down on zoom-in.
 */
const CursorOverlay: React.FC<{
  cx: number;
  cy: number;
  flashAmount: number; // 0 → 1, peaks at the click moment
  counterScale: number;
}> = ({ cx, cy, flashAmount, counterScale }) => {
  // Smaller cursor than v1: 32px nominal vs the previous 56px. Roughly
  // matches a real OS cursor at the recording's effective scale.
  const NOMINAL = 32;
  const cursorSize = NOMINAL * counterScale;
  // SVG viewBox tip at (3, 2) inside a 28×28 box. Map to pixel offsets in
  // the rendered SVG so we can offset the SVG so its tip sits at (cx, cy).
  const tipX = cursorSize * (3 / 28);
  const tipY = cursorSize * (2 / 28);
  const ringScale = 0.5 + flashAmount * 1.4;
  const ringOpacity = flashAmount * 0.85;
  return (
    <>
      {flashAmount > 0.02 && (
        <div
          style={{
            position: "absolute",
            left: cx,
            top: cy,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -90 * counterScale,
              top: -90 * counterScale,
              width: 180 * counterScale,
              height: 180 * counterScale,
              borderRadius: "50%",
              border: `${5 * counterScale}px solid #00e5a0`,
              transform: `scale(${ringScale})`,
              opacity: ringOpacity,
              boxShadow: `0 0 ${44 * counterScale}px #00e5a0`,
            }}
          />
        </div>
      )}
      <svg
        viewBox="0 0 28 28"
        width={cursorSize}
        height={cursorSize}
        style={{
          position: "absolute",
          left: cx - tipX,
          top: cy - tipY,
          filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.6))",
          pointerEvents: "none",
        }}
      >
        <path
          d="M3 2 L3 22 L8.5 17 L12 25 L15 23.5 L11.5 15.5 L19 15.5 Z"
          fill="#ffffff"
          stroke="#0a0a0a"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};
