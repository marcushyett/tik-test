import { AbsoluteFill, Audio, Easing, Sequence, interpolate, useCurrentFrame, useVideoConfig, staticFile } from "remotion";
import { Video } from "@remotion/media";
import { Background } from "./components/Background";
import { Intro } from "./components/Intro";
import { Outro } from "./components/Outro";
import { WordCaption } from "./components/WordCaption";
import { ToolBadge } from "./components/ToolBadge";

export interface BodyBadge {
  startS: number;
  durS: number;
  label: string;
  detail?: string;
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
  /** Single body narration. ONE Audio + ONE WordCaption span the entire
   *  master so the narration cannot leave a mid-body silence gap by
   *  construction. Pace is fit globally via bodyVoicePlaybackRate. */
  bodyVoiceSrc?: string;
  bodyVoiceDurS?: number;
  bodyVoicePlaybackRate?: number;
  bodyCaption?: string;
  /** Optional overlay cards keyed to silent investigative moments. Each
   *  badge mounts in its own Sequence at body-relative timestamps. */
  bodyBadges?: BodyBadge[];
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

      {/* Body — full trimmed recording with one continuous narration track. */}
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

  // Pan-zoom v3 — hold + fast-pan + wait, instead of slow drift.
  //   • APPROACH (0.5s before a click): zoom from 1.0 → PEAK
  //   • HOLD on prev click for HOLD_AFTER_CLICK_S so the page settles
  //     and the viewer reads the result of the action
  //   • PAN: fast — only kicks in PAN_DURATION_S BEFORE the next
  //     click, so the camera arrives just-in-time. No slow drift.
  //   • WAIT at next click position until that click actually fires
  //     (this happens implicitly because the pan ends at tNext)
  //   • RELEASE (no nearby next): ease back to 1.0 after the dwell
  //   • Gaps longer than SUSTAIN_THRESHOLD_S → release for the gap,
  //     re-approach when the next click is close
  const ZOOM_PEAK = 2.0;
  const APPROACH_S = 0.5;
  const HOLD_AFTER_CLICK_S = 1.2;
  const PAN_DURATION_S = 0.55;       // fast pan ≈ same speed as APPROACH_S
  const SUSTAIN_THRESHOLD_S = 12;    // up to this long, ride zoom between clicks
  const RELEASE_S = 0.6;

  let prevClick: typeof clicks[number] | null = null;
  let nextClick: typeof clicks[number] | null = null;
  for (const c of clicks) {
    if (c.ts / 1000 <= timeS) prevClick = c;
    else if (!nextClick) nextClick = c;
  }
  const tPrev = prevClick ? prevClick.ts / 1000 : -Infinity;
  const tNext = nextClick ? nextClick.ts / 1000 : Infinity;
  const sincePrev = timeS - tPrev;
  const untilNext = tNext - timeS;

  let zoomScale = 1;
  let focusVx = vw / 2;
  let focusVy = vh / 2;

  if (prevClick && nextClick && (tNext - tPrev) <= SUSTAIN_THRESHOLD_S) {
    // RIDE — stay at PEAK between adjacent clicks. Hold on prev, then
    // do a quick pan right before next, arriving at next-click position
    // just as the click fires.
    zoomScale = ZOOM_PEAK;
    const panStart = Math.max(tPrev + HOLD_AFTER_CLICK_S, tNext - PAN_DURATION_S);
    if (timeS < panStart) {
      focusVx = prevClick.x;
      focusVy = prevClick.y;
    } else {
      const span = Math.max(0.001, tNext - panStart);
      const t = Math.min(1, Math.max(0, (timeS - panStart) / span));
      const eased = Easing.bezier(0.4, 0, 0.2, 1)(t); // ease-in-out, fast
      focusVx = prevClick.x + (nextClick.x - prevClick.x) * eased;
      focusVy = prevClick.y + (nextClick.y - prevClick.y) * eased;
    }
  } else if (prevClick && sincePrev < HOLD_AFTER_CLICK_S + RELEASE_S) {
    // Just had a click but no nearby next — hold then ease out.
    focusVx = prevClick.x;
    focusVy = prevClick.y;
    if (sincePrev < HOLD_AFTER_CLICK_S) {
      zoomScale = ZOOM_PEAK;
    } else {
      const t = (sincePrev - HOLD_AFTER_CLICK_S) / RELEASE_S;
      const eased = Easing.bezier(0.4, 0, 0.2, 1)(Math.min(1, Math.max(0, t)));
      zoomScale = ZOOM_PEAK + (1 - ZOOM_PEAK) * eased;
    }
  } else if (nextClick && untilNext < APPROACH_S) {
    // Approaching the next click — ease zoom in toward it.
    focusVx = nextClick.x;
    focusVy = nextClick.y;
    const t = 1 - untilNext / APPROACH_S;
    const eased = Easing.bezier(0.4, 0, 0.2, 1)(Math.min(1, Math.max(0, t)));
    zoomScale = 1 + (ZOOM_PEAK - 1) * eased;
  } else {
    // Long stretch (intro/outro or genuine gap) — neutral, centred.
    // Conditional transform wrapper kicks in because zoom < 1.001,
    // so the <Video> renders directly with no compositing-layer blur.
    zoomScale = 1;
  }
  const focus = toCanvas(focusVx, focusVy);

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

      {/* The trimmed master recording. Mount the transform wrapper ONLY
          when actively punching in on a click — any non-identity
          transform forces the video onto its own GPU compositing layer,
          which gets bilinear-resampled into the parent every frame and
          softens text. With the wrapper conditional, the long stretches
          between clicks render the <Video> directly into the parent
          and stay pixel-sharp (assuming the recording's viewport size
          is canvas-friendly — see runner.ts viewport snapping). */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0a0a0a" }}>
        {zoomScale > 1.001 ? (
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
        ) : (
          <>
            <Video
              src={staticFile(input.masterVideoSrc)}
              muted
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
            <CursorOverlay
              cx={cursor.cx}
              cy={cursor.cy}
              flashAmount={flashAmount}
              counterScale={1}
            />
          </>
        )}
      </div>

      {/* ONE body voice + ONE caption track spanning the whole master.
          A single audio file can't leave silence gaps mid-body the way
          per-chunk audio could. WordCaption paces itself against the
          audio's effective (post-playbackRate) duration so subtitles
          stay locked to the spoken word. */}
      {input.bodyVoiceSrc && (
        <Audio
          src={staticFile(input.bodyVoiceSrc)}
          volume={1.1}
          playbackRate={input.bodyVoicePlaybackRate ?? 1}
        />
      )}
      {input.bodyCaption && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 240 }}>
          <WordCaption
            text={input.bodyCaption}
            durationInFrames={masterFrames}
            fps={fps}
            accent="#00e5a0"
            voiceDurS={input.bodyVoiceDurS ? input.bodyVoiceDurS / (input.bodyVoicePlaybackRate ?? 1) : undefined}
            voiceStartDelayS={0.05}
          />
        </div>
      )}

      {/* Overlay badges for silent investigative moments. Each pinned to
          its tool window's body-relative timestamp — independent of the
          narration audio, so they never desync with the on-screen action. */}
      {(input.bodyBadges ?? []).map((b, i) => {
        const startFrame = Math.round(b.startS * fps);
        const durFrames = Math.max(1, Math.round(b.durS * fps));
        return (
          <Sequence key={`badge-${i}`} from={startFrame} durationInFrames={durFrames} layout="none">
            <ToolBadge label={b.label} detail={b.detail} />
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
