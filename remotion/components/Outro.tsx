import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig, spring, interpolate, Easing, staticFile } from "remotion";
import { Background } from "./Background";
import { WordCaption } from "./WordCaption";

interface ChecklistItem {
  outcome: "success" | "failure" | "skipped";
  label: string;
  note?: string;
  goalId?: string;
}

interface GoalGroup {
  id: string;
  label: string;
  outcome: "success" | "failure" | "skipped";
}

interface Props {
  title: string;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  checklist?: ChecklistItem[];
  /** Goal-level headings used to group the granular checklist on the
   *  outro. When provided AND items carry goalId, the outro renders one
   *  heading per goal with its sub-checks underneath — matches the PR
   *  comment's grouping so the viewer's mental model stays consistent. */
  goalGroups?: GoalGroup[];
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
  captionText?: string;
}

export const Outro: React.FC<Props> = ({ title, stats, checklist, goalGroups, voiceSrc, voiceDurS, voicePlaybackRate, captionText }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const rise = spring({ frame, fps, from: 70, to: 0, config: { damping: 15, stiffness: 110 } });
  // Fade IN once, then HOLD at full opacity for the rest of the segment.
  // No fade-out — the user wants the checklist legible on the last frame
  // so a reviewer pausing at the end can read every pass/fail row.
  const opacity = spring({ frame, fps, from: 0, to: 1, config: { damping: 20 } });

  // Combined health: a sub-check failure is just as much a "red" as a
  // goal failure. Earlier the badge read "All green" while the checklist
  // below it had a red row — same inconsistency the PR comment used to
  // ship before its header was rewired. Now the pill mirrors the PR
  // comment's combined count.
  const checklistFailed = (checklist ?? []).filter((c) => c.outcome === "failure").length;
  const totalFailed = stats.failed + checklistFailed;
  const ok = totalFailed === 0;
  const accent = ok ? "#00e5a0" : "#ff4757";
  const status = ok
    ? "All green"
    : totalFailed === 1 ? "1 issue flagged" : `${totalFailed} issues flagged`;

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
            <Checklist items={checklist} goalGroups={goalGroups} />
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
 * Vertical checklist of every check the agent ran (LLM-synthesised from
 * the agent's action log). Each row: circular pass/fail glyph, scannable
 * label, optional one-line note for failures. Row size scales with item
 * count so up to 10 fit inside the safe band without colliding with
 * captions or going off-screen.
 */
const Checklist: React.FC<{ items: ChecklistItem[]; goalGroups?: GoalGroup[] }> = ({ items, goalGroups }) => {
  const dense = items.length > 7;
  const labelPx = dense ? 14 : 16;
  const notePx = dense ? 11 : 13;
  const padY = dense ? 6 : 8;
  const padX = dense ? 10 : 12;
  const gap = dense ? 6 : 8;
  const glyph = dense ? 18 : 20;

  // Bucket items by their goalId. Items without one fall into a catch-
  // all so they're never silently dropped (an LLM may forget the field).
  const byGoal = new Map<string, ChecklistItem[]>();
  for (const it of items) {
    const k = it.goalId ?? "_ungrouped";
    if (!byGoal.has(k)) byGoal.set(k, []);
    byGoal.get(k)!.push(it);
  }

  // Build the rendered sections in goal order. If we have no groups info
  // OR no items have goalIds, fall back to a flat list — same look as
  // before this feature, no regression for older artifacts.
  const groups = goalGroups ?? [];
  const haveAnyGoalId = items.some((i) => !!i.goalId);
  const sections: Array<{ key: string; group: GoalGroup | null; items: ChecklistItem[] }> = [];
  if (groups.length > 0 && haveAnyGoalId) {
    for (const g of groups) {
      const rows = byGoal.get(g.id);
      if (rows && rows.length > 0) sections.push({ key: g.id, group: g, items: rows });
    }
    const ungrouped = byGoal.get("_ungrouped");
    if (ungrouped && ungrouped.length > 0) sections.push({ key: "_ungrouped", group: null, items: ungrouped });
  } else {
    sections.push({ key: "_flat", group: null, items });
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: gap * 2,
        marginTop: dense ? 16 : 20,
        maxWidth: 480,
        marginLeft: "auto",
        marginRight: "auto",
        textAlign: "left",
      }}
    >
      {sections.map((sec) => (
        <div key={sec.key} style={{ display: "flex", flexDirection: "column", gap }}>
          {sec.group && <GoalHeading group={sec.group} dense={dense} />}
          {sec.items.map((item, i) => {
            const isFail = item.outcome === "failure";
            const isSkip = item.outcome === "skipped";
            const glyphColor = isFail ? "#ff5d5d" : isSkip ? "#94a3b8" : "#00e5a0";
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: dense ? 9 : 11,
                  padding: `${padY}px ${padX}px`,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.04)",
                  border: `1px solid ${isFail ? "rgba(255,93,93,0.28)" : "rgba(255,255,255,0.08)"}`,
                  marginLeft: sec.group ? (dense ? 12 : 16) : 0,
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    marginTop: 1,
                    width: glyph, height: glyph, borderRadius: 999,
                    background: glyphColor,
                    color: "#0a0a0a",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontWeight: 900, fontSize: glyph * 0.62, lineHeight: 1,
                  }}
                >
                  {isFail ? "✗" : isSkip ? "–" : "✓"}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: labelPx, fontWeight: 700, color: "#ffffff", lineHeight: 1.2, letterSpacing: "-0.005em" }}>
                    {item.label}
                  </div>
                  {item.note && (
                    <div style={{ fontSize: notePx, color: isFail ? "#ffb0b0" : "#9aa4b2", lineHeight: 1.3, marginTop: 2, fontWeight: 500 }}>
                      {item.note}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

const GoalHeading: React.FC<{ group: GoalGroup; dense: boolean }> = ({ group, dense }) => {
  const isFail = group.outcome === "failure";
  const isSkip = group.outcome === "skipped";
  const accent = isFail ? "#ff5d5d" : isSkip ? "#94a3b8" : "#00e5a0";
  const glyphSize = dense ? 16 : 18;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <div
        style={{
          flexShrink: 0,
          width: glyphSize, height: glyphSize, borderRadius: 999,
          background: accent,
          color: "#0a0a0a",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 900, fontSize: glyphSize * 0.62, lineHeight: 1,
        }}
      >
        {isFail ? "✗" : isSkip ? "–" : "✓"}
      </div>
      <div style={{
        fontSize: dense ? 15 : 17,
        fontWeight: 800,
        color: "#ffffff",
        letterSpacing: "-0.005em",
        textTransform: "none",
      }}>{group.label}</div>
    </div>
  );
};

const Block: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div style={{ padding: "14px 22px", borderRadius: 16, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(10px)", minWidth: 124 }}>
    <div style={{ fontSize: 60, fontWeight: 900, color, lineHeight: 1 }}>{value}</div>
    <div style={{ fontSize: 18, color: "#9aa4b2", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 6 }}>{label}</div>
  </div>
);
