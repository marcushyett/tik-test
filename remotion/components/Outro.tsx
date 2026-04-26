import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, staticFile } from "remotion";
import { Background } from "./Background";
import { WordCaption } from "./WordCaption";

interface Props {
  title: string;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
  captionText?: string;
}

export const Outro: React.FC<Props> = ({ title, stats, voiceSrc, voiceDurS, voicePlaybackRate, captionText }) => {
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
      {/* Anchored toward the top so the bottom 280px stays clear for captions. */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", padding: "120px 56px 0" }}>
        <div
          style={{
            fontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
            color: "#ffffff",
            textAlign: "center",
            transform: `translateY(${rise}px)`,
          }}
        >
          <div style={{ padding: "12px 28px", borderRadius: 18, background: accent, color: "#0a0a0a", display: "inline-block", fontSize: 32, fontWeight: 900, letterSpacing: "-0.01em", boxShadow: `0 14px 40px ${accent}66` }}>
            {status}
          </div>
          <div style={{ fontSize: outroTitleFontSize(title), fontWeight: 900, marginTop: 28, letterSpacing: "-0.02em", lineHeight: 1.05, maxWidth: 460, marginLeft: "auto", marginRight: "auto" }}>{title}</div>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 32 }}>
            <Block label="passed" value={stats.passed} color="#00e5a0" />
            <Block label="failed" value={stats.failed} color="#ff5d5d" />
            {stats.skipped > 0 && <Block label="skipped" value={stats.skipped} color="#94a3b8" />}
          </div>
        </div>
      </AbsoluteFill>
      {captionText && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 240 }}>
          <WordCaption
            text={captionText}
            durationInFrames={durationInFrames}
            fps={fps}
            accent={accent}
            voiceDurS={voiceDurS ? voiceDurS / (voicePlaybackRate ?? 1) : undefined}
            voiceStartDelayS={0.05}
          />
        </div>
      )}
      {voiceSrc && <Audio src={staticFile(voiceSrc)} volume={1.1} playbackRate={voicePlaybackRate ?? 1} />}
    </AbsoluteFill>
  );
};

function outroTitleFontSize(title: string): number {
  const n = title.length;
  if (n <= 12) return 76;
  if (n <= 20) return 60;
  if (n <= 30) return 48;
  return 40;
}

const Block: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div style={{ padding: "14px 22px", borderRadius: 16, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(10px)", minWidth: 124 }}>
    <div style={{ fontSize: 60, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 18, color: "#9aa4b2", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 6 }}>{label}</div>
  </div>
);
