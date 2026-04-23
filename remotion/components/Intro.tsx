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
          <div style={{ display: "inline-flex", alignItems: "center", gap: 14, padding: "12px 28px", borderRadius: 999, background: "linear-gradient(135deg, #00e5a0, #3cffe0)", color: "#0a0a0a", fontWeight: 800, fontSize: 32, letterSpacing: "0.08em", textTransform: "uppercase", boxShadow: "0 12px 40px rgba(0,229,160,0.4)" }}>
            tik-test review
          </div>
          {/* Title shrinks based on length so it always fits inside the 9:16 canvas — long
              plan names (e.g. "personadex — Theater mode deep walk-through") were overflowing
              before. */}
          <div
            style={{
              fontSize: titleFontSize(title),
              fontWeight: 900,
              lineHeight: 1.02,
              letterSpacing: "-0.03em",
              marginTop: 40,
              textShadow: "0 10px 40px rgba(0,0,0,0.45)",
              // Keep the text inside a column narrower than the canvas so it wraps instead of clipping.
              maxWidth: 900,
              marginLeft: "auto",
              marginRight: "auto",
              wordBreak: "break-word",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 42,
              color: "#bfc7d1",
              lineHeight: 1.25,
              marginTop: 32,
              fontWeight: 500,
              maxWidth: 900,
              marginLeft: "auto",
              marginRight: "auto",
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

/** Scale the title's font size to the length of the plan name so long titles fit the 9:16 canvas. */
function titleFontSize(title: string): number {
  const n = title.length;
  if (n <= 16) return 120;
  if (n <= 22) return 100;
  if (n <= 30) return 82;
  if (n <= 42) return 68;
  return 56;
}

const Stat: React.FC<{ label: string; value: string; accent: string }> = ({ label, value, accent }) => (
  <div style={{ padding: "22px 36px", borderRadius: 22, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(12px)" }}>
    <div style={{ fontSize: 72, fontWeight: 900, color: accent, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 28, color: "#9aa4b2", fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 6 }}>{label}</div>
  </div>
);
