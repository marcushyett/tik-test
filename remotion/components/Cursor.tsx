import { interpolate, Easing } from "remotion";

interface Props {
  frame: number;
  durationInFrames: number;
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  clickFrame?: number;
  scale: number;            // viewport→screen scale factor for translating coords
  offsetX: number;          // top-left of the browser band on the canvas
  offsetY: number;
  accent?: string;
}

export const Cursor: React.FC<Props> = ({
  frame, durationInFrames,
  from, to, clickFrame,
  scale, offsetX, offsetY,
  accent = "#00e5a0",
}) => {
  if (!to) return null;
  const start = from ?? to;
  // Travel finishes right before the click flash so the cursor is ON the element when it fires.
  const travelEnd = clickFrame != null
    ? Math.max(6, clickFrame - 2)
    : Math.round(durationInFrames * 0.55);
  const travelStart = Math.max(2, travelEnd - Math.max(8, Math.round(durationInFrames * 0.35)));
  const tRaw = interpolate(frame, [travelStart, travelEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });
  // Slight curved path for cinematic feel — offset perpendicular to the straight line midway.
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const px = -dy / (dist || 1);
  const py = dx / (dist || 1);
  const bulge = Math.min(80, dist * 0.15);
  const bend = Math.sin(tRaw * Math.PI) * bulge;
  const cursorX = start.x + dx * tRaw + px * bend;
  const cursorY = start.y + dy * tRaw + py * bend;

  const screenX = offsetX + cursorX * scale;
  const screenY = offsetY + cursorY * scale;

  // Click flash: short ring that expands + fades a few frames after the click frame.
  const flashStart = clickFrame ?? travelEnd;
  const flashActive = frame >= flashStart && frame <= flashStart + 20;
  const ringScale = flashActive
    ? interpolate(frame, [flashStart, flashStart + 18], [0.2, 1.8], { extrapolateRight: "clamp" })
    : 0;
  const ringOpacity = flashActive
    ? interpolate(frame, [flashStart, flashStart + 18], [0.9, 0], { extrapolateRight: "clamp" })
    : 0;

  return (
    <>
      {flashActive && (
        <div
          style={{
            position: "absolute",
            left: screenX,
            top: screenY,
            width: 140,
            height: 140,
            borderRadius: "50%",
            border: `6px solid ${accent}`,
            transform: `translate(-50%, -50%) scale(${ringScale})`,
            opacity: ringOpacity,
            boxShadow: `0 0 40px ${accent}`,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: screenX,
          top: screenY,
          width: 52,
          height: 52,
          transform: "translate(-20%, -15%)",
          filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.7))",
          pointerEvents: "none",
        }}
      >
        <svg viewBox="0 0 28 28" width="52" height="52">
          {/* Classic pointer: white body with dark outline for visibility on any bg. */}
          <path
            d="M3 2 L3 22 L8.5 17 L12 25 L15 23.5 L11.5 15.5 L19 15.5 Z"
            fill="#ffffff"
            stroke="#0a0a0a"
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </>
  );
};
