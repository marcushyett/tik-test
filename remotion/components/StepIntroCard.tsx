import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { Background } from "./Background";

interface Props {
  index: number;
  total: number;
  label: string;
  headline: string;
  accent: string;
}

export const StepIntroCard: React.FC<Props> = ({ index, total, label, headline, accent }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const riseIn = spring({ frame, fps, from: 60, to: 0, config: { damping: 14, stiffness: 140 } });
  const fadeIn = spring({ frame, fps, from: 0, to: 1, config: { damping: 18, stiffness: 160 } });
  const outStart = durationInFrames - 8;
  const fadeOut = interpolate(frame, [outStart, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  const opacity = Math.min(fadeIn, fadeOut);

  const counter = `STEP ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;

  return (
    <AbsoluteFill style={{ opacity }}>
      <Background accent={accent} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 80px" }}>
        <div
          style={{
            fontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
            color: "#ffffff",
            textAlign: "center",
            transform: `translateY(${riseIn}px)`,
          }}
        >
          <div style={{ color: accent, fontSize: 42, fontWeight: 800, letterSpacing: "0.18em", marginBottom: 20 }}>{counter}</div>
          <div
            style={{
              display: "inline-block",
              padding: "10px 22px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.08)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(255,255,255,0.14)",
              color: "#e8edf2",
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: "0.04em",
              marginBottom: 30,
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: 110,
              fontWeight: 900,
              lineHeight: 1.02,
              letterSpacing: "-0.02em",
              textWrap: "balance",
              textShadow: "0 6px 30px rgba(0,0,0,0.35)",
            }}
          >
            {headline}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
