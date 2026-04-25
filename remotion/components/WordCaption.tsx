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
 * TV-style subtitle: words appear at reading pace, the active word is highlighted,
 * and older words fade out so the caption never accumulates and overflows the
 * screen. At any given moment only a short rolling window (about one phrase's
 * worth) is visible.
 */
export const WordCaption: React.FC<Props> = ({
  text, durationInFrames, fps, accent = "#00e5a0",
  voiceDurS, voiceStartDelayS = 0.2,
}) => {
  const frame = useCurrentFrame();
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return null;

  const leadInFrames = Math.max(2, Math.round(fps * voiceStartDelayS));
  // Minimum 0.28s per word — below this, captions flash too fast to read.
  // With voice, pace to the narration; clamp to the min. Without voice, ~0.38s/word.
  const minWordFrames = Math.round(fps * 0.28);
  const perWordFrames = voiceDurS && voiceDurS > 0
    ? Math.max(minWordFrames, Math.floor((voiceDurS * fps) / words.length))
    : Math.max(minWordFrames, Math.floor((durationInFrames - leadInFrames) / words.length));

  // Rolling window: a word stays fully visible for WINDOW_WORDS word-durations
  // after it appears, then fades out over FADE_FRAMES. Tight enough that the
  // visible caption never stacks beyond ~one phrase.
  const WINDOW_WORDS = 7;
  const FADE_FRAMES = Math.round(fps * 0.25);

  return (
    <div
      style={{
        position: "absolute",
        left: 0, right: 0,
        bottom: 200,
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "0 48px",
        fontFamily: "'Inter Display', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      {words.map((w, i) => {
        const appearAt = leadInFrames + i * perWordFrames;
        const fadeStartAt = appearAt + WINDOW_WORDS * perWordFrames;
        const fadeEndAt = fadeStartAt + FADE_FRAMES;

        // Compute current opacity for this word.
        let opacity = 0;
        if (frame >= appearAt && frame < fadeStartAt) {
          // Quick fade-in over the first 5 frames after appearance.
          opacity = interpolate(frame, [appearAt, appearAt + 5], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          });
        } else if (frame >= fadeStartAt && frame < fadeEndAt) {
          opacity = interpolate(frame, [fadeStartAt, fadeEndAt], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.in(Easing.cubic),
          });
        } else {
          return null;
        }
        if (opacity <= 0.02) return null;

        const isCurrent = frame >= appearAt && frame < appearAt + perWordFrames;
        const fadingOut = frame >= fadeStartAt;
        const enterProgress = interpolate(frame, [appearAt, appearAt + 5], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const scale = interpolate(enterProgress, [0, 1], [0.85, 1]);

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `scale(${scale}) translateY(${(1 - enterProgress) * 8}px)`,
              color: isCurrent ? "#0a0a0a" : "#ffffff",
              backgroundColor: isCurrent ? accent : "rgba(10,10,10,0.78)",
              padding: "5px 11px",
              borderRadius: 9,
              fontSize: 40,
              fontWeight: 800,
              letterSpacing: "-0.005em",
              lineHeight: 1.05,
              textShadow: isCurrent ? "none" : "0 2px 8px rgba(0,0,0,0.5)",
              boxShadow: isCurrent
                ? `0 6px 22px ${accent}55`
                : (fadingOut ? "none" : "0 3px 10px rgba(0,0,0,0.4)"),
              transition: "none",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};
