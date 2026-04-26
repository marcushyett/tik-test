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
 * TV-style subtitle: words appear at reading pace, the active word is
 * highlighted, and older words fade out so the caption never accumulates
 * and overflows the screen. Tokens that LOOK technical (containing
 * brackets, equals signs, slashes, dots, or ALL_CAPS_SNAKE) render in
 * a monospace pill at slightly smaller size, so on-screen subtitles
 * naturally distinguish "click [data-testid=add]" from prose words.
 */
export const WordCaption: React.FC<Props> = ({
  text, durationInFrames, fps, accent = "#00e5a0",
  voiceDurS, voiceStartDelayS = 0.05,
}) => {
  const frame = useCurrentFrame();
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return null;

  const leadInFrames = Math.max(2, Math.round(fps * voiceStartDelayS));
  const minWordFrames = Math.round(fps * 0.28);
  const perWordFrames = voiceDurS && voiceDurS > 0
    ? Math.max(minWordFrames, Math.floor((voiceDurS * fps) / words.length))
    : Math.max(minWordFrames, Math.floor((durationInFrames - leadInFrames) / words.length));

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

        let opacity = 0;
        if (frame >= appearAt && frame < fadeStartAt) {
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
        const isTechnical = looksTechnical(w);

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `scale(${scale}) translateY(${(1 - enterProgress) * 8}px)`,
              color: isCurrent ? "#0a0a0a" : "#ffffff",
              backgroundColor: isCurrent
                ? accent
                : (isTechnical ? "rgba(20,24,32,0.85)" : "rgba(10,10,10,0.78)"),
              padding: isTechnical ? "4px 9px" : "5px 11px",
              borderRadius: isTechnical ? 7 : 9,
              border: isTechnical && !isCurrent ? "1px solid rgba(155,224,200,0.35)" : undefined,
              fontFamily: isTechnical
                ? "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace"
                : "inherit",
              fontSize: isTechnical ? 32 : 40,
              fontWeight: isTechnical ? 600 : 800,
              letterSpacing: isTechnical ? 0 : "-0.005em",
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

/**
 * A token "looks technical" when it carries syntax characters that prose
 * never contains: brackets, equals, slashes, hash, parens, or it's all-caps
 * snake/kebab. We strip surrounding punctuation (`,` `.` `;` `"` `'`) so the
 * detection still fires when the line ends with the technical token.
 */
function looksTechnical(token: string): boolean {
  const t = token.replace(/^[\s"'`(]+|[\s"'`),.;:!?]+$/g, "");
  if (t.length < 2) return false;
  if (/[\[\]=()/#]/.test(t)) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(t) && t.length >= 4) return true; // ALL_CAPS_SNAKE
  if (/^[a-z]+(-[a-z]+){2,}$/.test(t)) return true; // kebab-with-3+-parts (data-testid)
  return false;
}
