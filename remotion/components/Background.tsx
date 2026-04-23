import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";

interface Props {
  accent?: string;
  intensity?: number; // 0..1
}

export const Background: React.FC<Props> = ({ accent = "#00e5a0", intensity = 1 }) => {
  const frame = useCurrentFrame();
  // Slowly drift the gradient center for a subtle animated feel.
  const t = frame / 120;
  const cx = 50 + Math.sin(t) * 12;
  const cy = 50 + Math.cos(t * 0.7) * 10;
  const strength = Math.max(0, Math.min(1, intensity));
  const a = interpolate(strength, [0, 1], [0.15, 0.55]);

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(145deg, #0a0b12 0%, #12141d 45%, #0a0b12 100%)" }} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 80% 60% at ${cx}% ${cy}%, ${hexToRgba(accent, a * 0.4)} 0%, transparent 55%),
                       radial-gradient(ellipse 60% 80% at ${100 - cx}% ${100 - cy}%, rgba(132, 112, 255, ${a * 0.28}) 0%, transparent 60%),
                       radial-gradient(ellipse 40% 40% at 50% 120%, rgba(255,90,120,${a * 0.2}) 0%, transparent 70%)`,
          mixBlendMode: "screen",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 3px)`,
          opacity: 0.5,
        }}
      />
    </AbsoluteFill>
  );
};

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
