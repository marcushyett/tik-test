import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { StepSegment } from "./components/StepSegment";
import { Intro } from "./components/Intro";
import { Outro } from "./components/Outro";
import type { ReelInput } from "./schema";

export const VideoReel: React.FC<ReelInput> = (props) => {
  useVideoConfig();
  const { introDurFrames, outroDurFrames, steps } = props;
  let offset = 0;

  const introSeq = (
    <Sequence key="intro" from={offset} durationInFrames={introDurFrames} layout="none">
      <Intro
        title={props.title}
        summary={props.summary}
        stats={props.stats}
        voiceSrc={props.introVoiceSrc}
        voiceDurS={props.introVoiceDurS}
      />
    </Sequence>
  );
  offset += introDurFrames;

  const stepNodes = steps.map((step, i) => {
    const totalStepFrames = step.introDurFrames + step.stepDurFrames;
    const node = (
      <Sequence
        key={`step-${i}-${step.id}`}
        from={offset}
        durationInFrames={totalStepFrames}
        layout="none"
      >
        <StepSegment index={i} total={steps.length} step={step} viewport={props.viewport} />
      </Sequence>
    );
    offset += totalStepFrames;
    return node;
  });

  const outroSeq = (
    <Sequence key="outro" from={offset} durationInFrames={outroDurFrames} layout="none">
      <Outro
        title={props.title}
        stats={props.stats}
        voiceSrc={props.outroVoiceSrc}
        voiceDurS={props.outroVoiceDurS}
      />
    </Sequence>
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#07080c" }}>
      {introSeq}
      {stepNodes}
      {outroSeq}
    </AbsoluteFill>
  );
};
