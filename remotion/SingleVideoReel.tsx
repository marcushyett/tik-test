import { AbsoluteFill, Audio, Sequence, useVideoConfig, staticFile } from "remotion";
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
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background accent="#00e5a0" intensity={0.7} />

      {/* The trimmed master recording, full-bleed with object-fit: contain
          so the gradient peeks through above/below at mismatched aspect
          ratios. No pan/zoom — the chunked narration carries the story. */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0a0a0a" }}>
        <Video
          src={staticFile(input.masterVideoSrc)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
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
