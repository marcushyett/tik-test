import { useCurrentFrame, useVideoConfig, interpolate, Easing, spring } from "remotion";

interface Props {
  outcome: "success" | "failure" | "skipped";
  label: string;
}

/**
 * Animated check / cross / dash stamped over the video at the EXACT
 * moment a goal is verified by the agent. Two-stage entrance:
 *   1. The colored disc scales in with a spring.
 *   2. The check / cross / dash strokes draw on with stroke-dashoffset.
 * Then a label panel slides in below with the goal's short headline.
 *
 * Rendered above zoom/cursor overlays so it pierces through pan-zoom
 * — the goal of the stamp is to PUNCTUATE: the viewer sees a clear
 * "this thing was just verified" moment, even on noisy frames.
 */
export const VerificationStamp: React.FC<Props> = ({ outcome, label }) => {
  const frame = useCurrentFrame();
  const { fps, width: cw, height: ch } = useVideoConfig();

  const colors = outcome === "success"
    ? { ring: "#00e5a0", glow: "rgba(0,229,160,0.55)", text: "#0a0a0a" }
    : outcome === "failure"
      ? { ring: "#ff5577", glow: "rgba(255,85,119,0.55)", text: "#ffffff" }
      : { ring: "#a0a8b8", glow: "rgba(160,168,184,0.45)", text: "#0a0a0a" };

  // Disc spring-in across ~0.45s
  const discScale = spring({ frame, fps, config: { damping: 12, stiffness: 180 }, durationInFrames: Math.round(fps * 0.45) });

  // Stroke draw — starts after disc has popped (frame >= 6).
  const drawStart = Math.round(fps * 0.18);
  const drawEnd = Math.round(fps * 0.55);
  const drawProgress = interpolate(frame, [drawStart, drawEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Label slide-up, slightly delayed so disc lands first.
  const labelStart = Math.round(fps * 0.32);
  const labelEnd = Math.round(fps * 0.60);
  const labelOpacity = interpolate(frame, [labelStart, labelEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const labelY = interpolate(frame, [labelStart, labelEnd], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Whole stamp fade-out at the very end of the sequence.
  const fadeStart = Math.round(fps * 1.45);
  const fadeEnd = Math.round(fps * 1.80);
  const groupOpacity = interpolate(frame, [fadeStart, fadeEnd], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Disc geometry — ~22% of the shorter canvas dimension feels punchy
  // without dominating the frame. Center is at ~38% from the top so it
  // sits above the caption band and clear of the version badge.
  const discR = Math.round(Math.min(cw, ch) * 0.11);
  const discD = discR * 2;

  // Check path: M -0.55,0 L -0.18,0.42 L 0.62,-0.45 (in unit space, scaled by discR * 0.55).
  // Cross path: two diagonals.
  // Dash path (skipped): single horizontal bar.
  const u = discR * 0.55;
  const checkD = `M ${-0.55 * u} 0 L ${-0.10 * u} ${0.42 * u} L ${0.62 * u} ${-0.45 * u}`;
  const crossD = `M ${-0.45 * u} ${-0.45 * u} L ${0.45 * u} ${0.45 * u} M ${0.45 * u} ${-0.45 * u} L ${-0.45 * u} ${0.45 * u}`;
  const dashD = `M ${-0.55 * u} 0 L ${0.55 * u} 0`;

  const pathD = outcome === "success" ? checkD : outcome === "failure" ? crossD : dashD;
  const pathLen = outcome === "success" ? 1.55 * u : outcome === "failure" ? 2.55 * u : 1.10 * u;

  return (
    <div
      style={{
        position: "absolute",
        top: "32%",
        left: 0,
        right: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: groupOpacity,
        pointerEvents: "none",
        zIndex: 1900,
      }}
    >
      <div
        style={{
          position: "relative",
          width: discD,
          height: discD,
          transform: `scale(${discScale})`,
          transformOrigin: "center center",
          filter: `drop-shadow(0 8px 28px ${colors.glow})`,
        }}
      >
        <svg width={discD} height={discD} viewBox={`-${discR} -${discR} ${discD} ${discD}`}>
          <defs>
            <radialGradient id={`vstamp-grad-${outcome}`} cx="0.35" cy="0.30" r="0.95">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="55%" stopColor={colors.ring} stopOpacity="1" />
              <stop offset="100%" stopColor={colors.ring} stopOpacity="1" />
            </radialGradient>
          </defs>
          <circle cx="0" cy="0" r={discR - 4} fill={`url(#vstamp-grad-${outcome})`} stroke="rgba(255,255,255,0.35)" strokeWidth={3} />
          <path
            d={pathD}
            fill="none"
            stroke={colors.text}
            strokeWidth={discR * 0.18}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={pathLen}
            strokeDashoffset={pathLen * (1 - drawProgress)}
          />
        </svg>
      </div>
      <div
        style={{
          marginTop: 22,
          padding: "12px 22px",
          maxWidth: cw - 96,
          background: "rgba(10, 12, 18, 0.86)",
          border: `1px solid ${colors.ring}55`,
          borderRadius: 14,
          color: "rgba(255,255,255,0.95)",
          fontFamily: "'Inter Display', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif",
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: "-0.005em",
          textAlign: "center",
          opacity: labelOpacity,
          transform: `translateY(${labelY}px)`,
          boxShadow: `0 8px 22px rgba(0,0,0,0.45)`,
        }}
      >
        {label}
      </div>
    </div>
  );
};
