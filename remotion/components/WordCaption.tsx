import { useCurrentFrame, interpolate, Easing } from "remotion";

interface Props {
  text: string;
  durationInFrames: number;
  fps: number;
  accent?: string;
  voiceDurS?: number;        // when supplied, caption keeps pace with the narration
  voiceStartDelayS?: number; // narration starts this many seconds into the segment
}

/**
 * Phrase-by-phrase subtitle. The text is split into PAGES (one short
 * phrase, ~6 words max, also broken at commas / dashes / sentence ends).
 * A page appears as a whole, the currently-spoken word is highlighted,
 * and the entire page fades out before the next page appears. Word
 * positions never shift inside a page, so nothing visually "moves
 * backwards" while you're reading.
 *
 * Tokens that LOOK technical (containing brackets, equals signs, slashes,
 * dots, or ALL_CAPS_SNAKE / kebab-3+) render in a monospace pill at
 * smaller size, so on-screen subtitles naturally distinguish prose words
 * from selectors / values.
 */
export const WordCaption: React.FC<Props> = ({
  text, durationInFrames, fps, accent = "#00e5a0",
  voiceDurS, voiceStartDelayS = 0.05,
}) => {
  const frame = useCurrentFrame();
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return null;

  const leadInFrames = Math.max(2, Math.round(fps * voiceStartDelayS));
  // Minimum 0.28s per word — below this, captions flash too fast to read.
  // With voice, pace to the narration; clamp to the min. Without voice, ~0.38s/word.
  const minWordFrames = Math.round(fps * 0.28);
  const perWordFrames = voiceDurS && voiceDurS > 0
    ? Math.max(minWordFrames, Math.floor((voiceDurS * fps) / words.length))
    : Math.max(minWordFrames, Math.floor((durationInFrames - leadInFrames) / words.length));

  // ── Group words into PAGES so caption position stays stable per phrase.
  //   New page on punctuation OR at the soft cap. Cap = 6 words (≈ 2 lines).
  const pages = paginate(words, 6);

  // Each page's window: first word's appearAt → last word's appearAt + perWordFrames.
  // A small post-dwell keeps the page legible after the last word finishes; an
  // even smaller fade gap separates pages so the eye registers the change.
  const POST_DWELL = Math.round(fps * 0.18);
  const FADE_FRAMES = Math.round(fps * 0.18);

  // Find the active page (if any) at this frame.
  let active: { startWordIdx: number; endWordIdx: number; appearAt: number; lastWordAt: number; fadeStart: number; fadeEnd: number } | null = null;
  let cursor = 0;
  for (const page of pages) {
    const startWordIdx = cursor;
    const endWordIdx = cursor + page.length - 1;
    const appearAt = leadInFrames + startWordIdx * perWordFrames;
    const lastWordAt = leadInFrames + endWordIdx * perWordFrames;
    const fadeStart = lastWordAt + perWordFrames + POST_DWELL;
    const fadeEnd = fadeStart + FADE_FRAMES;
    if (frame >= appearAt && frame < fadeEnd) {
      active = { startWordIdx, endWordIdx, appearAt, lastWordAt, fadeStart, fadeEnd };
      break;
    }
    cursor = endWordIdx + 1;
  }
  if (!active) return null;

  const pageWords = words.slice(active.startWordIdx, active.endWordIdx + 1);

  // Whole-page opacity. Quick fade-in over 5 frames at appearAt; longer
  // fade-out over FADE_FRAMES at fadeStart so the page leaves cleanly.
  let pageOpacity = 1;
  if (frame < active.appearAt + 5) {
    pageOpacity = interpolate(frame, [active.appearAt, active.appearAt + 5], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  } else if (frame >= active.fadeStart) {
    pageOpacity = interpolate(frame, [active.fadeStart, active.fadeEnd], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.in(Easing.cubic),
    });
  }
  if (pageOpacity <= 0.02) return null;

  // Which word inside the page is the currently-spoken one? After all the
  // words have been "spoken", nothing is highlighted and the page just sits.
  const spokenIdx = Math.floor((frame - leadInFrames) / perWordFrames);
  const activeWordIdx = spokenIdx - active.startWordIdx;

  return (
    <div
      style={{
        position: "absolute",
        left: 0, right: 0,
        // Sit just above player chrome but as low as we can — the OLD 280px
        // anchor was overlapping main content because the body extends down
        // close to that line. The actually-reserved bottom band is ~130px
        // (mobile drawer peek pill + progress bar + iOS home indicator).
        // 140px clears all of that with ~10px of breathing room.
        bottom: 140,
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "0 48px",
        opacity: pageOpacity,
        fontFamily: "'Inter Display', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      {pageWords.map((w, i) => {
        const isCurrent = i === activeWordIdx;
        const isTechnical = looksTechnical(w);
        return (
          <span
            key={`${active!.startWordIdx}-${i}`}
            style={{
              display: "inline-block",
              color: isCurrent ? "#0a0a0a" : "#ffffff",
              backgroundColor: isCurrent
                ? accent
                : (isTechnical ? "rgba(20,24,32,0.85)" : "rgba(10,10,10,0.78)"),
              padding: isTechnical ? "4px 9px" : "5px 11px",
              borderRadius: isTechnical ? 7 : 9,
              border: isTechnical && !isCurrent ? "1px solid rgba(155,224,200,0.35)" : undefined,
              fontFamily: isTechnical
                ? "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace"
                : "inherit",
              fontSize: isTechnical ? 32 : 40,
              fontWeight: isTechnical ? 600 : 800,
              letterSpacing: isTechnical ? 0 : "-0.005em",
              lineHeight: 1.05,
              textShadow: isCurrent ? "none" : "0 2px 8px rgba(0,0,0,0.5)",
              boxShadow: isCurrent
                ? `0 6px 22px ${accent}55`
                : "0 3px 10px rgba(0,0,0,0.4)",
              transition: "none",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/**
 * Greedy paginator: start a fresh page after sentence-ending punctuation
 * (`. ! ?`), strong breaks (`,`, `;`, `:`, `—`), or once the page hits
 * the soft cap. Cap is small enough that pages fit in 1-2 wrapped lines
 * at the caption font size.
 */
function paginate(words: string[], cap: number): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    const last = w[w.length - 1] ?? "";
    const breaks = ".!?,;:—".includes(last);
    if (cur.length >= cap || (breaks && cur.length >= 3)) {
      pages.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

/**
 * A token "looks technical" when it carries syntax characters that prose
 * never contains: brackets, equals, slashes, hash, parens, or it's
 * all-caps snake / kebab-3+. We strip surrounding punctuation so detection
 * still fires when a sentence ends with the technical token.
 */
function looksTechnical(token: string): boolean {
  const t = token.replace(/^[\s"'`(]+|[\s"'`),.;:!?]+$/g, "");
  if (t.length < 2) return false;
  if (/[\[\]=()/#]/.test(t)) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(t) && t.length >= 4) return true;
  if (/^[a-z]+(-[a-z]+){2,}$/.test(t)) return true;
  return false;
}
