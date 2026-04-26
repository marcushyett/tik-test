import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

interface Props {
  label: string;
  detail?: string;
}

/**
 * Small status card pinned near the top of the frame during silent agent
 * moments (browser_evaluate, network probes, snapshots) so the viewer
 * understands what the agent is doing while the UI is static. The label
 * is plain English; the detail is a terminal-style one-liner.
 */
export const ToolBadge: React.FC<Props> = ({ label, detail }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tLocal = frame / fps;
  const fadeInDur = 0.25;
  const opacity = interpolate(tLocal, [0, fadeInDur], [0, 1], {
    easing: Easing.out(Easing.ease),
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        top: 100,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "10px 16px",
        borderRadius: 14,
        background: "rgba(10,12,18,0.85)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.96)",
        fontFamily: "'Geist', 'Inter', system-ui, sans-serif",
        fontWeight: 600,
        fontSize: 22,
        letterSpacing: "-0.005em",
        maxWidth: "82%",
        textAlign: "center",
        lineHeight: 1.25,
        opacity,
        boxShadow: "0 6px 22px rgba(0,0,0,0.4)",
        pointerEvents: "none",
        zIndex: 1500,
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 4, fontWeight: 700 }}>
        Agent
      </div>
      <div>{label}</div>
      {detail && (
        <div
          style={{
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
            fontSize: 13,
            opacity: 0.7,
            fontWeight: 500,
            marginTop: 6,
            letterSpacing: 0,
            color: "#9be0c8",
          }}
        >
          {detail}
        </div>
      )}
    </div>
  );
};
