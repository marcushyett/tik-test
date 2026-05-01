import { Composition } from "remotion";
import { VideoReel } from "./VideoReel";
import { FPS, OUT_H, OUT_W, computeTotalDuration, type ReelInput } from "./schema";
import { SingleVideoReel, computeSingleVideoDuration, type SingleVideoInput } from "./SingleVideoReel";

const DEFAULT_INPUT: ReelInput = {
  title: "tik-test preview",
  summary: "Pass empty inputProps — the CLI fills these at render time.",
  viewport: { width: 1920, height: 1080 },
  steps: [],
  introDurFrames: FPS * 3,
  outroDurFrames: FPS * 3,
  stats: { passed: 0, failed: 0, skipped: 0, total: 0, durS: 0 },
};

const DEFAULT_SINGLE_VIDEO_INPUT: SingleVideoInput = {
  title: "tik-test preview",
  summary: "Pass empty inputProps — the CLI fills these at render time.",
  masterVideoSrc: "master.mp4",
  viewport: { width: 1920, height: 1080 },
  masterDurS: 0,
  events: [],
  introDurFrames: FPS * 3,
  outroDurFrames: FPS * 3,
  stats: { passed: 0, failed: 0, skipped: 0, total: 0, durS: 0 },
};

export const RemotionRoot: React.FC = () => {
  const fallbackDuration = computeTotalDuration(DEFAULT_INPUT) || FPS * 5;
  return (
    <>
      <Composition
        id="VideoReel"
        component={VideoReel as any}
        width={OUT_W}
        height={OUT_H}
        fps={FPS}
        durationInFrames={fallbackDuration}
        defaultProps={DEFAULT_INPUT}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(FPS, computeTotalDuration(props)),
        })}
      />
      <Composition
        id="SingleVideoReel"
        component={SingleVideoReel as any}
        width={OUT_W}
        height={OUT_H}
        fps={FPS}
        durationInFrames={FPS * 5}
        defaultProps={DEFAULT_SINGLE_VIDEO_INPUT}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(FPS, computeSingleVideoDuration(props, FPS)),
        })}
      />
    </>
  );
};
