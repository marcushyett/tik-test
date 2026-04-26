import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, staticFile } from "remotion";
import { Background } from "./Background";
import { WordCaption } from "./WordCaption";

interface ChecklistItem {
  outcome: "success" | "failure" | "skipped";
  label: string;
  note?: string;
}

interface Props {
  title: string;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  checklist?: ChecklistItem[];
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
  captionText?: string;
}

export const Outro: React.FC<Props> = ({ title, stats, checklist, voiceSrc, voiceDurS, voicePlaybackRate, captionText }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const rise = spring({ frame, fps, from: 70, to: 0, config: { damping: 15, stiffness: 110 } });
  // Fade IN once, then HOLD at full opacity for the rest of the segment.
  // No fade-out — the user wants the checklist legible on the last frame
  // so a reviewer pausing at the end can read every pass/fail row.
  const opacity = spring({ frame, fps, from: 0, to: 1, config: { damping: 20 } });

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
          <div style={{ padding: "10px 24px", borderRadius: 16, background: accent, color: "#0a0a0a", display: "inline-block", fontSize: 26, fontWeight: 900, letterSpacing: "-0.01em", boxShadow: `0 12px 32px ${accent}66` }}>
            {status}
          </div>
          <div style={{ fontSize: outroTitleFontSize(title), fontWeight: 900, marginTop: 22, letterSpacing: "-0.02em", lineHeight: 1.05, maxWidth: 460, marginLeft: "auto", marginRight: "auto" }}>{title}</div>
          {checklist && checklist.length > 0 ? (
            <Checklist items={checklist} />
          ) : (
            <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 32 }}>
              <Block label="passed" value={stats.passed} color="#00e5a0" />
              <Block label="failed" value={stats.failed} color="#ff5d5d" />
              {stats.skipped > 0 && <Block label="skipped" value={stats.skipped} color="#94a3b8" />}
            </div>
          )}
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
  if (n <= 12) return 60;
  if (n <= 20) return 48;
  if (n <= 30) return 38;
  return 32;
}

/**
 * Vertical checklist of the actual goals the agent ran. Each row gets a
 * circular pass/fail glyph, the short label, and (for failures) a single
 * line of explanation underneath. Tight enough to fit 6 items in the
 * outro band without colliding with the bottom 280px caption zone.
 */
const Checklist: React.FC<{ items: ChecklistItem[] }> = ({ items }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24, maxWidth: 460, marginLeft: "auto", marginRight: "auto", textAlign: "left" }}>
    {items.map((item, i) => {
      const isFail = item.outcome === "failure";
      const isSkip = item.outcome === "skipped";
      const glyphColor = isFail ? "#ff5d5d" : isSkip ? "#94a3b8" : "#00e5a0";
      return (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 11,
            padding: "9px 12px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${isFail ? "rgba(255,93,93,0.28)" : "rgba(255,255,255,0.08)"}`,
          }}
        >
          <div
            style={{
              flexShrink: 0,
              marginTop: 2,
              width: 22, height: 22, borderRadius: 999,
              background: glyphColor,
              color: "#0a0a0a",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 900, fontSize: 14, lineHeight: 1,
            }}
          >
            {isFail ? "✗" : isSkip ? "–" : "✓"}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#ffffff", lineHeight: 1.2, letterSpacing: "-0.005em" }}>
              {item.label}
            </div>
            {item.note && (
              <div style={{ fontSize: 13, color: isFail ? "#ffb0b0" : "#9aa4b2", lineHeight: 1.3, marginTop: 3, fontWeight: 500 }}>
                {item.note}
              </div>
            )}
          </div>
        </div>
      );
    })}
  </div>
);

const Block: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div style={{ padding: "14px 22px", borderRadius: 16, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(10px)", minWidth: 124 }}>
    <div style={{ fontSize: 60, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 18, color: "#9aa4b2", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 6 }}>{label}</div>
  </div>
);
