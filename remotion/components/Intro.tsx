import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, staticFile } from "remotion";
import { Background } from "./Background";

interface Props {
  title: string;
  summary: string;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  voiceSrc?: string;
  voiceDurS?: number;
}

export const Intro: React.FC<Props> = ({ title, summary, stats, voiceSrc }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const rise = spring({ frame, fps, from: 80, to: 0, config: { damping: 16, stiffness: 120 } });
  const fadeIn = spring({ frame, fps, from: 0, to: 1, config: { damping: 20 } });
  const outStart = durationInFrames - 10;
  const fadeOut = interpolate(frame, [outStart, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ opacity }}>
      <Background accent="#00e5a0" intensity={1} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 80px" }}>
        <div
          style={{
            fontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
            color: "#ffffff",
            textAlign: "center",
            transform: `translateY(${rise}px)`,
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: 14, padding: "14px 26px", borderRadius: 999, background: "linear-gradient(135deg, #00e5a0, #3cffe0)", color: "#0a0a0a", fontWeight: 900, fontSize: 36, letterSpacing: "0.02em", boxShadow: "0 12px 40px rgba(0,229,160,0.4)" }}>
            <span style={{ fontSize: 44 }}>🎬</span> tik-test review
          </div>
          <div
            style={{
              fontSize: 128,
              fontWeight: 900,
              lineHeight: 1.0,
              letterSpacing: "-0.03em",
              marginTop: 40,
              textShadow: "0 10px 40px rgba(0,0,0,0.45)",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 46,
              color: "#bfc7d1",
              lineHeight: 1.2,
              marginTop: 36,
              fontWeight: 500,
            }}
          >
            {summary}
          </div>
          <div style={{ display: "flex", gap: 18, justifyContent: "center", marginTop: 60 }}>
            <Stat label="steps" value={String(stats.total)} accent="#ffffff" />
            <Stat label="duration" value={`${Math.max(1, Math.round(stats.durS))}s`} accent="#00e5a0" />
          </div>
        </div>
      </AbsoluteFill>
      {voiceSrc && <Audio src={staticFile(voiceSrc)} volume={1.1} />}
    </AbsoluteFill>
  );
};

const Stat: React.FC<{ label: string; value: string; accent: string }> = ({ label, value, accent }) => (
  <div style={{ padding: "22px 36px", borderRadius: 22, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(12px)" }}>
    <div style={{ fontSize: 72, fontWeight: 900, color: accent, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 28, color: "#9aa4b2", fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 6 }}>{label}</div>
  </div>
);
