import { useCurrentFrame, interpolate, Easing } from "remotion";

interface Props {
  text: string;
  durationInFrames: number;
  fps: number;
  accent?: string;
  voiceDurS?: number;        // when supplied, caption keeps pace with the narration
  voiceStartDelayS?: number; // narration starts this many seconds into the segment
}

/**
 * TikTok-style word-by-word subtitle: each word reveals at reading pace, sized
 * generously, with a tight semi-transparent pill behind each word.
 * When voiceDurS is passed, the word reveal is pinned to the narration timing so
 * captions and audio line up closely.
 */
export const WordCaption: React.FC<Props> = ({
  text, durationInFrames, fps, accent = "#00e5a0",
  voiceDurS, voiceStartDelayS = 0.2,
}) => {
  const frame = useCurrentFrame();
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return null;

  const leadInFrames = Math.max(2, Math.round(fps * voiceStartDelayS));
  // Minimum 0.33s per word — below this the captions flash too fast to read.
  // With voice, pace to the narration; clamp to the min so fast lines still stay
  // on-screen a reasonable time. Without voice, ~0.42s/word (2.4 words/sec).
  const minWordFrames = Math.round(fps * 0.33);
  const perWordFrames = voiceDurS && voiceDurS > 0
    ? Math.max(minWordFrames, Math.floor((voiceDurS * fps) / words.length))
    : Math.max(minWordFrames, Math.floor((durationInFrames - leadInFrames) / words.length));

  // Chunk words into lines of ~3-5 words for readability.
  const lines: string[][] = [];
  const words3 = 5;
  for (let i = 0; i < words.length; i += words3) lines.push(words.slice(i, i + words3));

  return (
    <div
      style={{
        position: "absolute",
        left: 0, right: 0,
        bottom: 160,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        padding: "0 40px",
        fontFamily: "'Inter Display', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      {lines.map((line, li) => {
        const baseWordIdx = lines.slice(0, li).reduce((a, l) => a + l.length, 0);
        return (
          <div key={li} style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            {line.map((w, wi) => {
              const i = baseWordIdx + wi;
              const appearAt = leadInFrames + i * perWordFrames;
              const progress = interpolate(frame, [appearAt, appearAt + 5], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.out(Easing.cubic),
              });
              if (progress <= 0) return null;
              // Highlight the CURRENT word
              const isCurrent = frame >= appearAt && frame < appearAt + perWordFrames;
              const scale = interpolate(progress, [0, 1], [0.8, 1]);
              return (
                <span
                  key={wi}
                  style={{
                    display: "inline-block",
                    opacity: progress,
                    transform: `scale(${scale}) translateY(${(1 - progress) * 12}px)`,
                    color: isCurrent ? "#0a0a0a" : "#ffffff",
                    backgroundColor: isCurrent ? accent : "rgba(10,10,10,0.82)",
                    padding: "6px 14px",
                    borderRadius: 12,
                    fontSize: 64,
                    fontWeight: 900,
                    letterSpacing: "-0.01em",
                    lineHeight: 1.05,
                    textShadow: isCurrent ? "none" : "0 2px 10px rgba(0,0,0,0.6)",
                    boxShadow: isCurrent ? `0 8px 28px ${accent}55` : "0 4px 14px rgba(0,0,0,0.45)",
                  }}
                >
                  {w}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
