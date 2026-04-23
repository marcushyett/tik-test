import { AbsoluteFill, Sequence, OffthreadVideo, Audio, useCurrentFrame, useVideoConfig, interpolate, Easing, staticFile } from "remotion";
import { StepIntroCard } from "./StepIntroCard";
import { Background } from "./Background";
import { WordCaption } from "./WordCaption";
import type { ReelStep } from "../schema";

interface Props {
  step: ReelStep;
  index: number;
  total: number;
  viewport: { width: number; height: number };
}

export const StepSegment: React.FC<Props> = ({ step, index, total, viewport }) => {
  useVideoConfig();
  const accent = pickAccent(step);

  const hasIntro = step.introDurFrames > 0;
  return (
    <AbsoluteFill>
      <Background accent={accent} intensity={step.importance === "critical" ? 1 : 0.75} />

      {hasIntro && (
        <Sequence from={0} durationInFrames={step.introDurFrames} layout="none">
          <StepIntroCard
            index={index}
            total={total}
            label={step.titleSlideLabel}
            headline={step.titleSlideText}
            accent={accent}
          />
        </Sequence>
      )}

      <Sequence from={step.introDurFrames} durationInFrames={step.stepDurFrames} layout="none">
        <StepClip step={step} viewport={viewport} accent={accent} />
      </Sequence>
    </AbsoluteFill>
  );
};

interface ClipProps {
  step: ReelStep;
  viewport: { width: number; height: number };
  accent: string;
}

const StepClip: React.FC<ClipProps> = ({ step, viewport, accent }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width: OUT_W, height: OUT_H } = useVideoConfig();

  // The clip was pre-rendered by ffmpeg at 540×960 (9:16) with all zoom/pan baked in.
  // Remotion just drops it into the canvas — NO CSS transforms, NO per-frame blur.
  // That's what makes the render fast: Chrome's job is overlay composition only.
  const bandW = OUT_W;
  const bandH = OUT_H;
  const bandX = 0;
  const bandY = 0;

  // End of clip: hold. Fade in from 0 in first few frames.
  const opacity = interpolate(frame, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Cursor scaling: viewport px → band px
  const cursorScale = bandW / viewport.width;
  const clipUrl = staticFile(step.clipSrc);

  return (
    <AbsoluteFill style={{ opacity }}>
      {/* Pre-baked clip fills the full canvas. Zoom, pan, motion blur, and centring
          on the target were all baked in by ffmpeg, so Remotion just composites. */}
      <OffthreadVideo
        src={clipUrl}
        playbackRate={step.playbackRate}
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />

      {/* Click-flash ring fires at the moment of the click, centred in the frame
          (the bake-in zoom brings the target to canvas centre). */}
      {step.clickFrame != null && (
        <ClickFlash frame={frame} clickFrame={step.clickFrame} accent={accent} />
      )}

      <WordCaption
        text={step.caption}
        durationInFrames={durationInFrames}
        fps={fps}
        accent={accent}
        voiceDurS={step.voiceDurS}
        voiceStartDelayS={0.0}
      />

      {/* Narration starts right at the top of the clip so audio + caption + action all share t=0. */}
      {step.voiceSrc && (
        <Audio src={staticFile(step.voiceSrc)} volume={1.1} />
      )}
    </AbsoluteFill>
  );
};

const ClickFlash: React.FC<{ frame: number; clickFrame: number; accent: string }> = ({ frame, clickFrame, accent }) => {
  const local = frame - clickFrame;
  if (local < 0 || local > 18) return null;
  const scale = interpolate(local, [0, 18], [0.2, 2.0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const opacity = interpolate(local, [0, 18], [0.95, 0], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 260,
        height: 260,
        borderRadius: "50%",
        border: `7px solid ${accent}`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
        boxShadow: `0 0 64px ${accent}`,
      }}
    />
  );
};

function pickAccent(step: ReelStep): string {
  if (step.outcome === "failure") return "#ff4757";
  if (step.importance === "critical") return "#ffc54a";
  if (step.importance === "high") return "#00e5a0";
  return "#8b7dff";
}
