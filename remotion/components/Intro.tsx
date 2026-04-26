import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, staticFile } from "remotion";
import { Background } from "./Background";
import { WordCaption } from "./WordCaption";

interface Props {
  title: string;
  summary: string;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
  captionText?: string;
}

/**
 * A title-card theme. Each theme tweaks the accent palette, typography, and
 * stat-card treatment so the feed doesn't feel like the same card rendered
 * fourteen times. Background gradient is produced by the shared `Background`
 * component, which we steer via `bgAccent` + `bgIntensity`.
 */
interface Theme {
  name: string;
  bgAccent: string;
  bgIntensity: number;
  pillGradient: string;
  pillInk: string;
  pillLabel: string;      // tagline that varies across themes — reviewing vs walk-through vs...
  pillShadow: string;
  titleFontFamily: string;
  titleColor: string;
  titleShadow: string;
  titleWeight: number;
  titleSpacing: string;
  summaryColor: string;
  statAccent: string;
  statBg: string;
  statBorder: string;
}

const THEMES: Theme[] = [
  // pulse — the original tik-test green-glow identity. Stays in rotation.
  {
    name: "pulse",
    bgAccent: "#00e5a0", bgIntensity: 1,
    pillGradient: "linear-gradient(135deg, #00e5a0, #3cffe0)",
    pillInk: "#0a0a0a",
    pillLabel: "tik-test review",
    pillShadow: "0 12px 40px rgba(0,229,160,0.4)",
    titleFontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
    titleColor: "#ffffff",
    titleShadow: "0 10px 40px rgba(0,0,0,0.45)",
    titleWeight: 900, titleSpacing: "-0.03em",
    summaryColor: "#bfc7d1",
    statAccent: "#00e5a0",
    statBg: "rgba(255,255,255,0.06)", statBorder: "1px solid rgba(255,255,255,0.1)",
  },
  // neon — hot magenta/cyan, high-contrast and a touch punk.
  {
    name: "neon",
    bgAccent: "#ff3d9e", bgIntensity: 1.1,
    pillGradient: "linear-gradient(135deg, #ff3d9e, #7b1fff)",
    pillInk: "#ffffff",
    pillLabel: "auto-reviewed",
    pillShadow: "0 12px 40px rgba(255,61,158,0.45)",
    titleFontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
    titleColor: "#ffffff",
    titleShadow: "0 0 36px rgba(255,61,158,0.4), 0 8px 36px rgba(0,0,0,0.55)",
    titleWeight: 900, titleSpacing: "-0.04em",
    summaryColor: "#e7c9ff",
    statAccent: "#ff3d9e",
    statBg: "rgba(255,255,255,0.05)", statBorder: "1px solid rgba(255,61,158,0.25)",
  },
  // paper — warm cream and ink, editorial. Serif title. Feels like a columnist.
  {
    name: "paper",
    bgAccent: "#f5c76a", bgIntensity: 0.65,
    pillGradient: "linear-gradient(135deg, #1f1a12, #3a2f1f)",
    pillInk: "#f2e6c7",
    pillLabel: "reviewed by tik-test",
    pillShadow: "0 10px 30px rgba(0,0,0,0.45)",
    titleFontFamily: "'Playfair Display', 'Georgia', 'Times New Roman', serif",
    titleColor: "#f8f3e3",
    titleShadow: "0 2px 12px rgba(0,0,0,0.4)",
    titleWeight: 800, titleSpacing: "-0.01em",
    summaryColor: "#cab99a",
    statAccent: "#f5c76a",
    statBg: "rgba(245,199,106,0.08)", statBorder: "1px solid rgba(245,199,106,0.25)",
  },
  // aurora — purple/blue wash, monospaced label. Quiet and technical.
  {
    name: "aurora",
    bgAccent: "#6e6bff", bgIntensity: 0.9,
    pillGradient: "linear-gradient(135deg, #6e6bff, #26d0ff)",
    pillInk: "#ffffff",
    pillLabel: "tik-test pass",
    pillShadow: "0 12px 40px rgba(110,107,255,0.35)",
    titleFontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
    titleColor: "#ffffff",
    titleShadow: "0 8px 30px rgba(0,0,0,0.5)",
    titleWeight: 800, titleSpacing: "-0.025em",
    summaryColor: "#b7c4ff",
    statAccent: "#26d0ff",
    statBg: "rgba(38,208,255,0.06)", statBorder: "1px solid rgba(38,208,255,0.2)",
  },
  // ember — deep orange and charcoal. Warm and urgent.
  {
    name: "ember",
    bgAccent: "#ff7a1a", bgIntensity: 0.95,
    pillGradient: "linear-gradient(135deg, #ff7a1a, #ffc25c)",
    pillInk: "#1a1108",
    pillLabel: "walk-through",
    pillShadow: "0 12px 36px rgba(255,122,26,0.38)",
    titleFontFamily: "'Inter Display', 'Inter', -apple-system, Arial, sans-serif",
    titleColor: "#fff4e3",
    titleShadow: "0 10px 30px rgba(0,0,0,0.55)",
    titleWeight: 900, titleSpacing: "-0.03em",
    summaryColor: "#f4cfa6",
    statAccent: "#ffc25c",
    statBg: "rgba(255,194,92,0.07)", statBorder: "1px solid rgba(255,122,26,0.25)",
  },
];

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickTheme(seed: string): Theme {
  return THEMES[stableHash(seed) % THEMES.length];
}

export const Intro: React.FC<Props> = ({ title, summary, stats, voiceSrc, voiceDurS, voicePlaybackRate, captionText }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const theme = pickTheme(title || summary || "tik-test");

  const rise = spring({ frame, fps, from: 80, to: 0, config: { damping: 16, stiffness: 120 } });
  const fadeIn = spring({ frame, fps, from: 0, to: 1, config: { damping: 20 } });
  const outStart = durationInFrames - 10;
  const fadeOut = interpolate(frame, [outStart, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ opacity }}>
      <Background accent={theme.bgAccent} intensity={theme.bgIntensity} />
      {/* Anchored toward the top so the bottom 280px stays clear for captions. */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", padding: "120px 56px 0" }}>
        <div
          style={{
            fontFamily: theme.titleFontFamily,
            color: theme.titleColor,
            textAlign: "center",
            transform: `translateY(${rise}px)`,
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "9px 22px", borderRadius: 999, background: theme.pillGradient, color: theme.pillInk, fontWeight: 800, fontSize: 22, letterSpacing: "0.1em", textTransform: "uppercase", boxShadow: theme.pillShadow }}>
            {theme.pillLabel}
          </div>
          <div
            style={{
              fontSize: titleFontSize(title),
              fontWeight: theme.titleWeight,
              lineHeight: 1.05,
              letterSpacing: theme.titleSpacing,
              marginTop: 28,
              textShadow: theme.titleShadow,
              maxWidth: 460,
              marginLeft: "auto",
              marginRight: "auto",
              wordBreak: "break-word",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 28,
              color: theme.summaryColor,
              lineHeight: 1.3,
              marginTop: 22,
              fontWeight: 500,
              maxWidth: 460,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            {summary}
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 36 }}>
            <Stat label={stats.total === 1 ? "check" : "checks"} value={String(stats.total)} accent={theme.statAccent} theme={theme} />
          </div>
        </div>
      </AbsoluteFill>
      {captionText && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 240 }}>
          <WordCaption
            text={captionText}
            durationInFrames={durationInFrames}
            fps={fps}
            accent={theme.statAccent}
            voiceDurS={voiceDurS ? voiceDurS / (voicePlaybackRate ?? 1) : undefined}
            voiceStartDelayS={0.05}
          />
        </div>
      )}
      {voiceSrc && <Audio src={staticFile(voiceSrc)} volume={1.1} playbackRate={voicePlaybackRate ?? 1} />}
    </AbsoluteFill>
  );
};

/** Scale the title's font size to the length of the plan name so it fits
 *  comfortably on 1-2 lines inside the compact 460px-wide intro band. */
function titleFontSize(title: string): number {
  const n = title.length;
  if (n <= 12) return 88;
  if (n <= 20) return 70;
  if (n <= 30) return 58;
  if (n <= 42) return 48;
  return 40;
}

const Stat: React.FC<{ label: string; value: string; accent: string; theme: Theme }> = ({ label, value, accent, theme }) => (
  <div style={{ padding: "14px 28px", borderRadius: 18, background: theme.statBg, border: theme.statBorder, backdropFilter: "blur(12px)" }}>
    <div style={{ fontSize: 52, fontWeight: 900, color: accent, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 18, color: theme.summaryColor, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 4 }}>{label}</div>
  </div>
);
