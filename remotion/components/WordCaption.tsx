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
  // When VOICE is provided, captions track it exactly — even if that means
  // a word's highlight only sits for a few frames. The viewer can read a
  // whole page at a glance once it appears; the highlight is just a "you
  // are here" indicator and lagging the voice for legibility loses the
  // sync, which is worse. Cap the effective duration at the segment so a
  // sequence cut-off doesn't cause the highlight to outrun the visible
  // captions.
  // Without voice, fall back to ~0.38s/word with a 0.28s floor so pages
  // don't flash unreadably fast.
  const captionSpanFrames = voiceDurS && voiceDurS > 0
    ? Math.max(1, Math.min(durationInFrames - leadInFrames, Math.round(voiceDurS * fps)))
    : Math.max(1, durationInFrames - leadInFrames);
  const minWordFramesNoVoice = Math.round(fps * 0.28);
  const perWordFrames = voiceDurS && voiceDurS > 0
    ? Math.max(1, Math.floor(captionSpanFrames / words.length))
    : Math.max(minWordFramesNoVoice, Math.floor(captionSpanFrames / words.length));

  // ── Group words into PAGES so caption position stays stable per phrase.
  //   New page on punctuation OR at the soft cap. Cap = 6 words (≈ 2 lines).
  const pages = paginate(words, 6);

  // Each page's window: first word's appearAt → last word's appearAt + perWordFrames.
  // A small post-dwell keeps the page legible after the last word finishes; an
  // even smaller fade gap separates pages so the eye registers the change.
  const POST_DWELL = Math.round(fps * 0.18);
  const FADE_FRAMES = Math.round(fps * 0.18);

  // Build per-page timing windows up-front, then pick the LATEST page
  // whose appearAt has already passed. If we picked the first match (in
  // order), an earlier page still fading would visually block a later
  // page that should have started — the cure is just to prefer "latest
  // started" so caption pages turn over crisply with the voice.
  type PageWin = { startWordIdx: number; endWordIdx: number; appearAt: number; lastWordAt: number; fadeStart: number; fadeEnd: number };
  const pageWindows: PageWin[] = [];
  {
    let cursor = 0;
    for (const page of pages) {
      const startWordIdx = cursor;
      const endWordIdx = cursor + page.length - 1;
      const appearAt = leadInFrames + startWordIdx * perWordFrames;
      const lastWordAt = leadInFrames + endWordIdx * perWordFrames;
      const fadeStart = lastWordAt + perWordFrames + POST_DWELL;
      const fadeEnd = fadeStart + FADE_FRAMES;
      pageWindows.push({ startWordIdx, endWordIdx, appearAt, lastWordAt, fadeStart, fadeEnd });
      cursor = endWordIdx + 1;
    }
  }
  let active: PageWin | null = null;
  for (let i = pageWindows.length - 1; i >= 0; i--) {
    const p = pageWindows[i];
    if (frame >= p.appearAt && frame < p.fadeEnd) {
      active = p;
      break;
    }
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
 * A token "looks technical" when it carries structural markers that prose
 * effectively never contains: brackets, equals, slashes, hash, parens,
 * underscores, dotted identifier paths, camelCase, or kebab-3+. Surrounding
 * punctuation is stripped first so a sentence-final selector still matches.
 *
 * Bare ALL-CAPS words ("DONE", "MUST", "WHEN") are NOT technical — that
 * pattern fires far too often on prose emphasis. Real constants almost
 * always have an underscore or digit (`API_KEY`, `HTTP2`) which the
 * syntax-char rule catches via the underscore.
 */
function looksTechnical(token: string): boolean {
  const t = token.replace(/^[\s"'`(]+|[\s"'`),.;:!?]+$/g, "");
  if (t.length < 3) return false;
  if (/[\[\]=()/#_]/.test(t)) return true;
  if (/^\w+\.\w+(\.\w+)*$/.test(t)) return true;
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(t)) return true;
  if (/^[a-z]+(-[a-z]+){2,}$/.test(t)) return true;
  return false;
}
