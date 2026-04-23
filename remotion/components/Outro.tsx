import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, staticFile } from "remotion";
import { Background } from "./Background";

interface Props {
  title: string;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  voiceSrc?: string;
  voiceDurS?: number;
}

export const Outro: React.FC<Props> = ({ title, stats, voiceSrc }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const rise = spring({ frame, fps, from: 70, to: 0, config: { damping: 15, stiffness: 110 } });
  const fadeIn = spring({ frame, fps, from: 0, to: 1, config: { damping: 20 } });
  const outStart = durationInFrames - 12;
  const fadeOut = interpolate(frame, [outStart, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = Math.min(fadeIn, fadeOut);

  const ok = stats.failed === 0;
  const accent = ok ? "#00e5a0" : "#ff4757";
  const status = ok ? "All green" : "Issues found";

  return (
    <AbsoluteFill style={{ opacity }}>
      <Background accent={accent} intensity={1} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 80px" }}>
        <div
          style={{
            fontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
            color: "#ffffff",
            textAlign: "center",
            transform: `translateY(${rise}px)`,
          }}
        >
          <div style={{ padding: "22px 50px", borderRadius: 24, background: accent, color: "#0a0a0a", display: "inline-block", fontSize: 72, fontWeight: 900, letterSpacing: "-0.01em", boxShadow: `0 20px 60px ${accent}66` }}>
            {status}
          </div>
          <div style={{ fontSize: 96, fontWeight: 900, marginTop: 42, letterSpacing: "-0.02em" }}>{title}</div>
          <div style={{ display: "flex", gap: 18, justifyContent: "center", marginTop: 50 }}>
            <Block label="passed" value={stats.passed} color="#00e5a0" />
            <Block label="failed" value={stats.failed} color="#ff5d5d" />
            {stats.skipped > 0 && <Block label="skipped" value={stats.skipped} color="#94a3b8" />}
          </div>
          <div style={{ fontSize: 34, color: "#8b98a7", marginTop: 40, fontWeight: 600 }}>
            {stats.durS.toFixed(1)}s · {stats.total} checks
          </div>
          <div style={{ fontSize: 30, color: "#6b7684", marginTop: 60, fontWeight: 500 }}>
            Swipe → next review
          </div>
        </div>
      </AbsoluteFill>
      {voiceSrc && <Audio src={staticFile(voiceSrc)} volume={1.1} />}
    </AbsoluteFill>
  );
};

const Block: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div style={{ padding: "22px 32px", borderRadius: 20, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(10px)", minWidth: 180 }}>
    <div style={{ fontSize: 88, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 26, color: "#9aa4b2", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 8 }}>{label}</div>
  </div>
);
