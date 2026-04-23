import { AbsoluteFill, Audio, Sequence, useCurrentFrame, useVideoConfig, interpolate, Easing, staticFile } from "remotion";
import { Video } from "@remotion/media";
import { Background } from "./components/Background";
import { Intro } from "./components/Intro";
import { Outro } from "./components/Outro";
import { WordCaption } from "./components/WordCaption";

export interface SingleVideoEvent {
  index: number;
  kind: string;
  importance: "low" | "normal" | "high" | "critical";
  outcome: "success" | "failure" | "skipped";
  description: string;
  startS: number;
  endS: number;
  caption: string;
  voiceSrc?: string;
  voiceDurS?: number;            // natural voice length
  voicePlaybackRate?: number;     // speed factor so voice fits the window (1.0..~1.5)
  targetX?: number;
  targetY?: number;
  clickAtS?: number;
}

export interface SingleVideoInput {
  title: string;
  summary: string;
  masterVideoSrc: string;
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
  /** Persistent version badge (e.g. "v0.2.0 · 6590731") — rendered top-right
   *  so a reviewer can tell at a glance which CLI build produced this video. */
  versionTag?: string;
}

export function computeSingleVideoDuration(input: SingleVideoInput, fps: number): number {
  const masterFrames = Math.round(input.masterDurS * fps);
  return input.introDurFrames + masterFrames + input.outroDurFrames;
}

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
        />
      </Sequence>

      {/* Main body — the full trimmed recording with overlays. */}
      <Sequence from={props.introDurFrames} durationInFrames={masterFrames} layout="none">
        <SingleVideoBody input={props} />
      </Sequence>

      {/* Outro */}
      <Sequence from={props.introDurFrames + masterFrames} durationInFrames={props.outroDurFrames} layout="none">
        <Outro
          title={props.title}
          stats={props.stats}
          voiceSrc={props.outroVoiceSrc}
          voiceDurS={props.outroVoiceDurS}
        />
      </Sequence>

      {/* Persistent version badge — tiny, semi-transparent, top-right corner.
          Tells a reviewer which CLI commit produced the video so old and new
          videos in the feed are distinguishable at a glance. */}
      {props.versionTag && <VersionBadge tag={props.versionTag} />}
    </AbsoluteFill>
  );
};

// Version badge: persistent across the whole video, but MUST be cheap to
// render. Earlier versions used backdrop-filter: blur which forces a
// composited layer per frame and halved the Remotion encode throughput
// (6–10 fps → 3 fps). Solid opaque pill achieves the same legibility at
// effectively zero cost per frame.
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
  const frame = useCurrentFrame();
  const { fps, width: OUT_W, height: OUT_H } = useVideoConfig();
  const t = frame / fps;

  // Which event are we currently on?
  const currentIdx = input.events.findIndex((e) => t >= e.startS && t < e.endS);
  const current = currentIdx >= 0 ? input.events[currentIdx] : undefined;

  // The video band fills the ENTIRE canvas; the caption floats over the top bottom half.
  // object-fit: contain keeps the whole viewport visible (never crops the UI), letting the
  // gradient Background peek through above/below when aspect ratios mismatch.
  const bandW = OUT_W;
  const bandH = OUT_H;
  const bandX = 0;
  const bandY = 0;

  // Where the video actually lands inside the band (contain layout).
  // This is the math Chrome uses internally for object-fit: contain.
  const vRatio = input.viewport.width / input.viewport.height;
  const bandRatio = bandW / bandH;
  let videoW = bandW;
  let videoH = bandH;
  if (vRatio > bandRatio) videoH = bandW / vRatio;
  else videoW = bandH * vRatio;
  const videoX = bandX + (bandW - videoW) / 2;
  const videoY = bandY + (bandH - videoH) / 2;

  // --- Pan/zoom driven by the current event's target ---
  const tx = current?.targetX;
  const ty = current?.targetY;
  const vw = input.viewport.width;
  const vh = input.viewport.height;
  const hasFocus = tx !== undefined && ty !== undefined;

  // Smoothly ramp into the event's zoom over 0.3s starting at startS, and
  // ramp back to 1.0x over 0.35s ending at endS.
  let zoom = 1.0;
  let originXPct = 50;
  let originYPct = 50;
  if (current && hasFocus) {
    const eLen = current.endS - current.startS;
    const fadeIn = 0.3;
    const fadeOut = 0.4;
    const tLocal = t - current.startS;
    const isImportant =
      current.importance === "critical" ? 1.45 :
      current.importance === "high" ? 1.3 :
      current.outcome === "failure" ? 1.4 :
      1.18;
    let peak = isImportant;
    // Soft ease in / out
    let amt = 1;
    if (tLocal < fadeIn) amt = Easing.bezier(0.22, 1, 0.36, 1)(tLocal / fadeIn);
    else if (tLocal > eLen - fadeOut) amt = Easing.bezier(0.22, 1, 0.36, 1)(Math.max(0, (eLen - tLocal) / fadeOut));
    zoom = 1.0 + (peak - 1.0) * amt;
    originXPct = Math.min(90, Math.max(10, (tx! / vw) * 100));
    originYPct = Math.min(90, Math.max(10, (ty! / vh) * 100));
  }

  // Each narration gets its OWN time window. The Sequence's durationInFrames
  // guarantees the audio stops at the window's end, and playbackRate scales the
  // natural voice length to fit. Result: zero audio overlap, ever.
  const audioTracks = input.events
    .filter((e) => !!e.voiceSrc)
    .map((e) => {
      const startFrame = Math.round(e.startS * fps);
      const durFrames = Math.max(1, Math.round((e.endS - e.startS) * fps));
      return (
        <Sequence key={`a-${e.index}`} from={startFrame} durationInFrames={durFrames} layout="none">
          <Audio
            src={staticFile(e.voiceSrc!)}
            volume={1.1}
            playbackRate={e.voicePlaybackRate ?? 1}
          />
        </Sequence>
      );
    });

  return (
    <AbsoluteFill>
      <Background accent={pickAccent(current)} intensity={0.7} />

      {/* The master recording — baked zoom/pan applied purely via CSS transform here.
          Since OffthreadVideo is one continuous source, Chrome stays hot and render is fast. */}
      <div
        style={{
          position: "absolute",
          left: bandX,
          top: bandY,
          width: bandW,
          height: bandH,
          overflow: "hidden",
          background: "#0a0a0a",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            transform: `scale(${zoom})`,
            transformOrigin: `${originXPct}% ${originYPct}%`,
            willChange: "transform",
          }}
        >
          <Video
            src={staticFile(input.masterVideoSrc)}
            muted
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </div>
      </div>

      {/* Click flash at the click moment */}
      {current && current.clickAtS != null && hasFocus && (
        <ClickFlashOverlay
          t={t}
          clickAtS={current.clickAtS}
          targetX={tx!}
          targetY={ty!}
          viewport={input.viewport}
          bandX={bandX}
          bandY={bandY}
          bandW={bandW}
          bandH={bandH}
          zoom={zoom}
          originXPct={originXPct}
          originYPct={originYPct}
          accent={pickAccent(current)}
        />
      )}

      {/* One captions Sequence per event so each word-reveal starts at t=0 for its event.
          Only the currently-active sequence contributes visible DOM. */}
      {input.events.map((e) => {
        const startFrame = Math.round(e.startS * fps);
        const durFrames = Math.max(1, Math.round((e.endS - e.startS) * fps));
        return (
          <Sequence key={`cap-${e.index}`} from={startFrame} durationInFrames={durFrames} layout="none">
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 240 }}>
              <WordCaption
                text={e.caption}
                durationInFrames={durFrames}
                fps={fps}
                accent={pickAccent(e)}
                voiceDurS={e.voiceDurS}
                voiceStartDelayS={0.0}
              />
            </div>
          </Sequence>
        );
      })}

      {audioTracks}
    </AbsoluteFill>
  );
};

interface ClickFlashProps {
  t: number;
  clickAtS: number;
  targetX: number;
  targetY: number;
  viewport: { width: number; height: number };
  bandX: number; bandY: number; bandW: number; bandH: number;
  zoom: number;
  originXPct: number;
  originYPct: number;
  accent: string;
}

const ClickFlashOverlay: React.FC<ClickFlashProps> = ({ t, clickAtS, targetX, targetY, viewport, bandX, bandY, bandW, bandH, zoom, originXPct, originYPct, accent }) => {
  const tLocal = t - clickAtS;
  if (tLocal < 0 || tLocal > 0.6) return null;

  // Map target (viewport coords) → screen position, respecting zoom/origin.
  const nx = targetX / viewport.width;
  const ny = targetY / viewport.height;
  const pre = { x: bandX + nx * bandW, y: bandY + ny * bandH };
  const ox = bandX + (originXPct / 100) * bandW;
  const oy = bandY + (originYPct / 100) * bandH;
  const post = { x: ox + (pre.x - ox) * zoom, y: oy + (pre.y - oy) * zoom };

  const ringScale = interpolate(tLocal, [0, 0.5], [0.3, 2.2], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const ringOpacity = interpolate(tLocal, [0, 0.5], [0.95, 0], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        left: post.x,
        top: post.y,
        width: 260,
        height: 260,
        borderRadius: "50%",
        border: `7px solid ${accent}`,
        transform: `translate(-50%, -50%) scale(${ringScale})`,
        opacity: ringOpacity,
        boxShadow: `0 0 64px ${accent}`,
      }}
    />
  );
};

function pickAccent(ev?: SingleVideoEvent): string {
  if (!ev) return "#00e5a0";
  if (ev.outcome === "failure") return "#ff4757";
  if (ev.importance === "critical") return "#ffc54a";
  if (ev.importance === "high") return "#00e5a0";
  return "#8b7dff";
}
