import { AbsoluteFill, Audio, Easing, Sequence, interpolate, useCurrentFrame, useVideoConfig, staticFile } from "remotion";
import { Video } from "@remotion/media";
import { Background } from "./components/Background";
import { Intro } from "./components/Intro";
import { Outro } from "./components/Outro";
import { WordCaption } from "./components/WordCaption";
import { ToolBadge } from "./components/ToolBadge";
import { VerificationStamp } from "./components/VerificationStamp";

export interface BodyChunk {
  startS: number;
  durS: number;
  text: string;
  voiceSrc?: string;
  voiceDurS?: number;
  voicePlaybackRate?: number;
}

export interface BodyBadge {
  startS: number;
  durS: number;
  label: string;
  detail?: string;
}

export interface SingleVideoInput {
  title: string;
  summary: string;
  masterVideoSrc: string;
  viewport: { width: number; height: number };
  masterDurS: number;
  introDurFrames: number;
  outroDurFrames: number;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  introVoiceSrc?: string;
  introVoiceDurS?: number;
  introVoicePlaybackRate?: number;
  introCaption?: string;
  outroVoiceSrc?: string;
  outroVoiceDurS?: number;
  outroVoicePlaybackRate?: number;
  outroCaption?: string;
  versionTag?: string;
  /** Body narration as TIMED beats — one chunk per narrator beat. Each
   *  chunk renders its own Audio + WordCaption Sequence at body-relative
   *  startS, so the spoken word is anchored to the on-screen moment by
   *  construction. Chunks are sorted, non-overlapping, cover the master. */
  bodyChunks: BodyChunk[];
  /** Optional overlay cards keyed to silent investigative moments. Each
   *  badge mounts in its own Sequence at body-relative timestamps,
   *  independent of the narration audio. */
  bodyBadges?: BodyBadge[];
  /** Animated check / cross / dash stamps timed to each goal's verification
   *  moment — body-relative seconds. Punctuates the video so the viewer
   *  sees exactly when the agent declared a pass / fail / skip. */
  verificationStamps?: Array<{ atS: number; outcome: "success" | "failure" | "skipped"; label: string }>;
  /** Agent-planned camera plan — one body-relative window per demo step,
   *  with a `mode` directive (tight / wide / follow) and optional focus
   *  point in viewport pixels (same coord space as `interactions`).
   *  When this is provided, pan-zoom is ENTIRELY agent-directed; the
   *  legacy click-reactive logic falls back only when it's missing. */
  cameraPlan?: Array<{ startS: number; durS: number; mode: "tight" | "wide" | "follow"; focusX?: number; focusY?: number }>;
  /** Active-region rect in viewport pixels — anchors the BASE camera framing
   *  so a desktop recording whose actual app fills only ~30% of the viewport
   *  (Taskpad-style centered card) zooms in to fill the canvas. Per-step
   *  cameraPlan modes layer on top of this base. */
  contentBbox?: { x: number; y: number; width: number; height: number };
  /** Body-relative intervals where pan-zoom should RELEASE — computed by
   *  the editor from post-click DOM mutations that landed outside the
   *  clicked element. When the page changes far from where you clicked,
   *  the viewer should see the whole page, not a held zoom on the click
   *  site. Empty / missing means "no off-target mutations detected,
   *  ride zoom is fine for every gap." */
  zoomReleaseIntervals?: Array<{ startS: number; durS: number }>;
  /** Mouse + click stream (already mapped to master-timeline ms by the editor).
   *  `move` events drive the cursor overlay; `click` events drive both the
   *  cursor flash AND the targeted pan-zoom toward the click bbox. Coords are
   *  in VIEWPORT (page) pixels — Remotion maps them to canvas pixels via the
   *  recording's objectFit:contain math. */
  interactions?: Array<{ ts: number; kind: "move" | "click" | "key"; x: number; y: number; key?: string }>;
  checklist?: Array<{ outcome: "success" | "failure" | "skipped"; label: string; note?: string; goalId?: string }>;
  /** Goal-level headings used to GROUP the granular checklist on the outro.
   *  When provided AND items carry goalId, the outro renders one heading
   *  per goal with its sub-checks underneath — matches the PR comment's
   *  grouping so the viewer's mental model stays consistent across the
   *  two surfaces. Order here is the order goals will appear in. */
  goalGroups?: Array<{ id: string; label: string; outcome: "success" | "failure" | "skipped" }>;
}

export function computeSingleVideoDuration(input: SingleVideoInput, fps: number): number {
  const masterFrames = Math.round(input.masterDurS * fps);
  return input.introDurFrames + masterFrames + input.outroDurFrames;
}

/**
 * SAFE-AREA RULES — read this before adding ANY new on-screen element.
 *
 * The rendered video is 9:16 and plays full-bleed inside the tik-test web
 * viewer (and inside Slack / Twitter / iOS native players). The viewer
 * overlays its own UI ON TOP of the video so it doesn't push the video
 * down — meaning these zones of the rendered frame may be partially
 * covered by player chrome at any moment:
 *
 *   - TOP 0..120px        viewer header bar ("All repos" + repo title)
 *                          plus iOS / Android browser status bar.
 *   - BOTTOM 0..130px     OUR progress bar, mute button, mobile drawer
 *                          peek pill, iOS home indicator, embedded-player
 *                          native controls.
 *   - BOTTOM 130..240px   caption band (paginated WordCaption renders here
 *                          — only captions, no other content).
 *   - TOP-RIGHT 120×120   version badge (see VersionBadge below).
 *
 * Hard rule: NO main content (titles, stats, body badges, lists) in any
 * of those zones. Use the middle band (top ~120 → bottom ~240). Captions
 * are the ONE exception that lives in the bottom safe band.
 */

export const SingleVideoReel: React.FC<SingleVideoInput> = (props) => {
  const { fps } = useVideoConfig();
  const masterFrames = Math.round(props.masterDurS * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: "#07080c" }}>
      {/* Intro */}
      <Sequence from={0} durationInFrames={props.introDurFrames} layout="none">
        <Intro
          title={props.title}
          summary={props.summary}
          stats={props.stats}
          voiceSrc={props.introVoiceSrc}
          voiceDurS={props.introVoiceDurS}
          voicePlaybackRate={props.introVoicePlaybackRate}
          captionText={props.introCaption}
        />
      </Sequence>

      {/* Body — full trimmed recording with one continuous narration track. */}
      <Sequence from={props.introDurFrames} durationInFrames={masterFrames} layout="none">
        <SingleVideoBody input={props} />
      </Sequence>

      {/* Outro */}
      <Sequence from={props.introDurFrames + masterFrames} durationInFrames={props.outroDurFrames} layout="none">
        <Outro
          title={props.title}
          stats={props.stats}
          checklist={props.checklist}
          goalGroups={props.goalGroups}
          voiceSrc={props.outroVoiceSrc}
          voiceDurS={props.outroVoiceDurS}
          voicePlaybackRate={props.outroVoicePlaybackRate}
          captionText={props.outroCaption}
        />
      </Sequence>

      {props.versionTag && <VersionBadge tag={props.versionTag} />}
    </AbsoluteFill>
  );
};

const VersionBadge: React.FC<{ tag: string }> = ({ tag }) => (
  <div
    style={{
      position: "absolute",
      top: 24,
      right: 24,
      padding: "3px 8px",
      borderRadius: 6,
      background: "rgba(10, 12, 18, 0.45)",
      color: "rgba(255,255,255,0.55)",
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: "0.04em",
      pointerEvents: "none",
      zIndex: 2000,
    }}
  >
    {tag}
  </div>
);

const SingleVideoBody: React.FC<{ input: SingleVideoInput }> = ({ input }) => {
  const { fps, width: canvasW, height: canvasH } = useVideoConfig();
  const frame = useCurrentFrame();
  const timeS = frame / fps;

  // Recording → canvas mapping (objectFit: contain). Pure function of the
  // viewport size and canvas size; computed once per render.
  const vw = input.viewport.width;
  const vh = input.viewport.height;
  const fitScale = Math.min(canvasW / vw, canvasH / vh);
  const fitW = vw * fitScale;
  const fitH = vh * fitScale;
  const offsetX = (canvasW - fitW) / 2;
  const offsetY = (canvasH - fitH) / 2;
  const toCanvas = (x: number, y: number) => ({
    cx: offsetX + x * fitScale,
    cy: offsetY + y * fitScale,
  });

  // ── BASE AUTO-ZOOM from contentBbox.
  //
  // For desktop recordings (1920×1080) where the actual app fills only a
  // small centered region, the canvas was rendering ~70% empty background
  // with the app crammed into a thin band. Now: when contentBbox is
  // provided, we compute a base zoom that scales the active region to
  // FILL the canvas while still centering on the bbox.
  //
  // Math: contentBbox is in viewport pixels. After fitScale, it occupies
  // (bbox.width * fitScale, bbox.height * fitScale) canvas pixels.
  // Auto-zoom is the LARGEST scale that still fits the bbox within the
  // canvas without cropping. Clamped to [1, 3.5] so we don't (a) zoom
  // OUT for already-full-bleed apps, (b) over-magnify on tiny bboxes.
  // The base origin shifts toward the bbox center so the zoom is
  // anchored on the active content, not the recording center.
  let baseZoom = 1;
  let baseFocusVx = vw / 2;
  let baseFocusVy = vh / 2;
  if (input.contentBbox && input.contentBbox.width > 0 && input.contentBbox.height > 0) {
    const bb = input.contentBbox;
    const bbCanvasW = bb.width * fitScale;
    const bbCanvasH = bb.height * fitScale;
    // Min — we want the bbox to FIT inside the canvas, not overflow.
    // (max would crop sides; min preserves the entire bbox.)
    const fillScale = Math.min(canvasW / bbCanvasW, canvasH / bbCanvasH);
    baseZoom = Math.max(1, Math.min(3.5, fillScale));
    baseFocusVx = bb.x + bb.width / 2;
    baseFocusVy = bb.y + bb.height / 2;
  }

  const interactions = input.interactions ?? [];
  const clicks = interactions.filter((i) => i.kind === "click");

  // Cursor path — click-to-click travel with ease-out. Playwright MCP
  // emits very few raw mousemove events (its locator.click() hits the
  // target without painting an intermediate trail), so interpolating
  // between sparse moves leaves the cursor crawling. Instead we drive
  // the cursor purely off click positions: it sits on the previous
  // click, then glides over to the next one in TRAVEL_S before that
  // click's flash fires. Result: human-paced motion with the cursor
  // ALWAYS arriving exactly where the page is about to be tapped.
  const TRAVEL_S = 0.55;
  let cursorVx = vw / 2;
  let cursorVy = vh / 2;
  if (clicks.length > 0) {
    // Default — before the first click, sit at the first click's spot
    cursorVx = clicks[0].x;
    cursorVy = clicks[0].y;
    for (let i = 0; i < clicks.length; i++) {
      const tc = clicks[i].ts / 1000;
      if (timeS >= tc) {
        cursorVx = clicks[i].x;
        cursorVy = clicks[i].y;
        continue;
      }
      // We are between clicks[i-1] and clicks[i] (or before the first)
      const prev = i > 0 ? clicks[i - 1] : clicks[i];
      const travelStart = Math.max((prev.ts / 1000) + 0.05, tc - TRAVEL_S);
      if (timeS <= travelStart) {
        cursorVx = prev.x;
        cursorVy = prev.y;
      } else {
        const span = Math.max(0.001, tc - travelStart);
        const tRaw = Math.min(1, Math.max(0, (timeS - travelStart) / span));
        const tEased = Easing.bezier(0.22, 1, 0.36, 1)(tRaw); // ease-out so the cursor decelerates onto the target
        cursorVx = prev.x + (clicks[i].x - prev.x) * tEased;
        cursorVy = prev.y + (clicks[i].y - prev.y) * tEased;
      }
      break;
    }
  }
  const cursor = toCanvas(cursorVx, cursorVy);

  // Pan-zoom v5 — ride zoom between clicks BY DEFAULT (so a tight
  // interaction sequence stays magnified for clarity), but RELEASE to
  // neutral framing when we have a signal that something off-focus is
  // happening on the page that the viewer should see.
  //
  // Two release signals:
  //   1. SILENT BEAT in the gap. Whenever the agent is investigating
  //      (browser_evaluate / network / console reads) the page may be
  //      mutating somewhere we can't predict. The compositor doesn't know
  //      WHERE on the page state is changing, so the safe framing is the
  //      whole page — release zoom for those windows.
  //   2. FAR CLICKS. If the next click is in a different region of the
  //      page (distance > FAR_DISTANCE_PX in viewport coords), riding
  //      zoom would camera-cross the whole page held magnified. Release
  //      so the viewer sees both regions and the cursor traversal.
  //
  // If neither signal fires for the gap, we ride: hold on prev click,
  // then pan to next click in the last PAN_DURATION_S so the camera
  // arrives just as the click fires. This is what made tight form-fill
  // sequences feel magnified and intentional in earlier versions.
  const ZOOM_PEAK = 2.0;
  const APPROACH_S = 0.5;
  const HOLD_AFTER_CLICK_S = 1.0;
  const PAN_DURATION_S = 0.55;
  const RELEASE_S = 0.5;
  const FAR_DISTANCE_PX = Math.min(vw, vh) * 0.4; // ~40% of shorter viewport dim

  let prevClick: typeof clicks[number] | null = null;
  let nextClick: typeof clicks[number] | null = null;
  for (const c of clicks) {
    if (c.ts / 1000 <= timeS) prevClick = c;
    else if (!nextClick) nextClick = c;
  }
  const tPrev = prevClick ? prevClick.ts / 1000 : -Infinity;
  const tNext = nextClick ? nextClick.ts / 1000 : Infinity;
  const sincePrev = timeS - tPrev;
  const untilNext = tNext - timeS;

  // Decide whether the gap between prev and next click should release.
  // Two release signals, each sufficient on its own:
  //   1. Off-target DOM mutation (zoomReleaseIntervals): the page changed
  //      somewhere outside the clicked element's bbox. The editor built
  //      these intervals from page-side MutationObserver data, so this is
  //      a real "the toast appeared in the corner" signal, not a heuristic.
  //   2. Far clicks (distance > FAR_DISTANCE_PX): the next click is in a
  //      different region of the page; ride-mode would camera-cross over
  //      the page held magnified, with neither region clearly readable.
  //      Release for the gap so the viewer sees both.
  let releaseGap = false;
  if (prevClick && nextClick) {
    const distanceFar = Math.hypot(nextClick.x - prevClick.x, nextClick.y - prevClick.y) > FAR_DISTANCE_PX;
    const gapStart = tPrev + HOLD_AFTER_CLICK_S;
    const gapEnd = tNext - APPROACH_S;
    const offTargetInGap = (input.zoomReleaseIntervals ?? []).some((b) => {
      const bEnd = b.startS + b.durS;
      return b.startS < gapEnd && bEnd > gapStart;
    });
    releaseGap = distanceFar || offTargetInGap;
  }

  let zoomScale = 1;
  let focusVx = vw / 2;
  let focusVy = vh / 2;

  // ── AGENT-PLANNED CAMERA (preferred when present).
  //
  // The agent that designed the demo also chose a camera mode per step
  // (tight / wide / follow) and surfaced focus coords for tight/follow
  // entries. When a cameraPlan exists we drive zoom + focus PURELY from
  // it — this is "thought through and adapted to the video script", not
  // ad-hoc reactive rules. Smooth ease across entry boundaries so the
  // camera transitions feel natural even when consecutive steps switch
  // mode (e.g. tight → wide as the action moves from a button to a
  // page-wide list update).
  //
  // Modes:
  //   • wide   — zoom 1.0, framing centered. The default; most viewer-
  //              friendly. Used when the result spans the page.
  //   • tight  — zoom ~1.6 on the step's focus point. Used when ONE
  //              specific control is the subject.
  //   • follow — start tight on the focus, ease out to wide over the
  //              step's duration. Used when an action triggers a side
  //              effect elsewhere on the page that the viewer needs to
  //              track from cause to effect.
  //
  // Falls through to the legacy click-reactive path when no plan is
  // provided (older recordings, edge-case runs that bypassed pass 2).
  if (input.cameraPlan && input.cameraPlan.length > 0) {
    // Tight is BOTH the agent's "punch in on this control" mode AND the
    // multiplier on top of base auto-zoom. We use a SOFTER tight factor
    // (1.35) when the base zoom is already large, so we don't end up at
    // baseZoom × 1.6 = 4.5×+ which would crop most things off-canvas.
    const TIGHT_FACTOR = baseZoom > 2.0 ? 1.25 : 1.6;
    const TIGHT_ZOOM = baseZoom * TIGHT_FACTOR;
    const TRANSITION_S = 0.35;
    const computeTarget = (e: NonNullable<SingleVideoInput["cameraPlan"]>[number], t: number) => {
      if (e.mode === "tight") {
        return {
          zoom: TIGHT_ZOOM,
          fx: e.focusX ?? baseFocusVx,
          fy: e.focusY ?? baseFocusVy,
        };
      }
      if (e.mode === "follow") {
        const elapsed = Math.max(0, Math.min(e.durS, t - e.startS));
        const progress = elapsed / Math.max(0.001, e.durS);
        const eased = Easing.bezier(0.25, 0, 0.2, 1)(Math.min(1, Math.max(0, progress)));
        // Ease from tight back to BASE (not 1.0) — the base is still
        // useful framing on the active region, and dropping all the way
        // to 1.0 would suddenly reveal all the empty desktop background.
        const z = TIGHT_ZOOM + (baseZoom - TIGHT_ZOOM) * eased;
        return {
          zoom: z,
          fx: e.focusX ?? baseFocusVx,
          fy: e.focusY ?? baseFocusVy,
        };
      }
      // "wide" — sit at the BASE auto-zoom on the content bbox center.
      // (Was zoom=1.0 + center; that mode left desktop apps swimming in
      // background. Now wide = "the natural framing of the active app".)
      return { zoom: baseZoom, fx: baseFocusVx, fy: baseFocusVy };
    };
    // Find the active entry for this frame. Plan is sorted ascending.
    let active = -1;
    for (let i = 0; i < input.cameraPlan.length; i++) {
      const e = input.cameraPlan[i];
      if (timeS >= e.startS && timeS < e.startS + e.durS) { active = i; break; }
      if (timeS < e.startS) break;
    }
    if (active === -1) {
      // Before first entry (intro tail) or after last (outro prelude) →
      // sit at the BASE framing so the recording is still well-framed
      // even between cameraPlan entries (e.g. while a verification
      // stamp pops up).
      zoomScale = baseZoom;
      focusVx = baseFocusVx;
      focusVy = baseFocusVy;
    } else {
      const e = input.cameraPlan[active];
      const tgt = computeTarget(e, timeS);
      const intoEntry = timeS - e.startS;
      if (active > 0 && intoEntry < TRANSITION_S) {
        const prev = input.cameraPlan[active - 1];
        const prevTgt = computeTarget(prev, e.startS);
        const t = Math.min(1, Math.max(0, intoEntry / TRANSITION_S));
        const eased = Easing.bezier(0.4, 0, 0.2, 1)(t);
        zoomScale = prevTgt.zoom + (tgt.zoom - prevTgt.zoom) * eased;
        focusVx = prevTgt.fx + (tgt.fx - prevTgt.fx) * eased;
        focusVy = prevTgt.fy + (tgt.fy - prevTgt.fy) * eased;
      } else if (active === 0 && intoEntry < TRANSITION_S) {
        // First entry — ease from BASE framing so we always start framed
        // on the active content, not zoomed all the way out.
        const t = Math.min(1, Math.max(0, intoEntry / TRANSITION_S));
        const eased = Easing.bezier(0.4, 0, 0.2, 1)(t);
        zoomScale = baseZoom + (tgt.zoom - baseZoom) * eased;
        focusVx = baseFocusVx + (tgt.fx - baseFocusVx) * eased;
        focusVy = baseFocusVy + (tgt.fy - baseFocusVy) * eased;
      } else {
        zoomScale = tgt.zoom;
        focusVx = tgt.fx;
        focusVy = tgt.fy;
      }
    }
  } else if (prevClick && sincePrev < HOLD_AFTER_CLICK_S && nextClick) {
    // HOLD on the click site — viewer reads the immediate reaction.
    focusVx = prevClick.x;
    focusVy = prevClick.y;
    zoomScale = ZOOM_PEAK;
  } else if (prevClick && nextClick && !releaseGap) {
    // RIDE — stay at PEAK, pan to next click in the last PAN_DURATION_S.
    zoomScale = ZOOM_PEAK;
    const panStart = Math.max(tPrev + HOLD_AFTER_CLICK_S, tNext - PAN_DURATION_S);
    if (timeS < panStart) {
      focusVx = prevClick.x;
      focusVy = prevClick.y;
    } else {
      const span = Math.max(0.001, tNext - panStart);
      const t = Math.min(1, Math.max(0, (timeS - panStart) / span));
      const eased = Easing.bezier(0.4, 0, 0.2, 1)(t);
      focusVx = prevClick.x + (nextClick.x - prevClick.x) * eased;
      focusVy = prevClick.y + (nextClick.y - prevClick.y) * eased;
    }
  } else if (prevClick && nextClick && releaseGap) {
    // RELEASE for this gap. Ease PEAK → 1.0 first, then sit neutral, then
    // re-approach the next click in the last APPROACH_S.
    if (untilNext < APPROACH_S) {
      // APPROACH next click out of release.
      focusVx = nextClick.x;
      focusVy = nextClick.y;
      const t = 1 - untilNext / APPROACH_S;
      const eased = Easing.bezier(0.4, 0, 0.2, 1)(Math.min(1, Math.max(0, t)));
      zoomScale = 1 + (ZOOM_PEAK - 1) * eased;
    } else if (sincePrev < HOLD_AFTER_CLICK_S + RELEASE_S) {
      // RELEASE EASE — focus stays on prev click while we ease out.
      focusVx = prevClick.x;
      focusVy = prevClick.y;
      const t = (sincePrev - HOLD_AFTER_CLICK_S) / RELEASE_S;
      const eased = Easing.bezier(0.4, 0, 0.2, 1)(Math.min(1, Math.max(0, t)));
      zoomScale = ZOOM_PEAK + (1 - ZOOM_PEAK) * eased;
    } else {
      // NEUTRAL — full-page view during the silent / far-click window.
      zoomScale = 1;
    }
  } else if (!prevClick && nextClick && untilNext < APPROACH_S) {
    // First-click APPROACH (no prev click yet, body just started).
    focusVx = nextClick.x;
    focusVy = nextClick.y;
    const t = 1 - untilNext / APPROACH_S;
    const eased = Easing.bezier(0.4, 0, 0.2, 1)(Math.min(1, Math.max(0, t)));
    zoomScale = 1 + (ZOOM_PEAK - 1) * eased;
  } else if (prevClick && !nextClick && sincePrev < HOLD_AFTER_CLICK_S + RELEASE_S) {
    // FINAL release after the last click.
    focusVx = prevClick.x;
    focusVy = prevClick.y;
    if (sincePrev < HOLD_AFTER_CLICK_S) {
      zoomScale = ZOOM_PEAK;
    } else {
      const t = (sincePrev - HOLD_AFTER_CLICK_S) / RELEASE_S;
      const eased = Easing.bezier(0.4, 0, 0.2, 1)(Math.min(1, Math.max(0, t)));
      zoomScale = ZOOM_PEAK + (1 - ZOOM_PEAK) * eased;
    }
  } else {
    // NEUTRAL — pre-first-click body opening, or post-last-release.
    // Sits at base auto-zoom on the content bbox center when available
    // (no contentBbox → baseZoom=1, baseFocus=center, identical behaviour).
    zoomScale = baseZoom;
    focusVx = baseFocusVx;
    focusVy = baseFocusVy;
  }
  const focus = toCanvas(focusVx, focusVy);

  // Click flash — any click within ±0.18s gets a ring expansion centred on
  // the click point.
  const FLASH_HALF_S = 0.18;
  let flashAmount = 0;
  for (const c of clicks) {
    const dt = Math.abs(timeS - c.ts / 1000);
    if (dt < FLASH_HALF_S) {
      const local = 1 - dt / FLASH_HALF_S;
      if (local > flashAmount) flashAmount = local;
    }
  }

  return (
    <AbsoluteFill>
      <Background accent="#00e5a0" intensity={0.7} />

      {/* The trimmed master recording. Mount the transform wrapper ONLY
          when actively punching in on a click — any non-identity
          transform forces the video onto its own GPU compositing layer,
          which gets bilinear-resampled into the parent every frame and
          softens text. With the wrapper conditional, the long stretches
          between clicks render the <Video> directly into the parent
          and stay pixel-sharp (assuming the recording's viewport size
          is canvas-friendly — see runner.ts viewport snapping). */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0a0a0a" }}>
        {zoomScale > 1.001 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `scale(${zoomScale})`,
              transformOrigin: `${focus.cx}px ${focus.cy}px`,
            }}
          >
            <Video
              src={staticFile(input.masterVideoSrc)}
              muted
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
            <CursorOverlay
              cx={cursor.cx}
              cy={cursor.cy}
              flashAmount={flashAmount}
              counterScale={1 / zoomScale}
            />
          </div>
        ) : (
          <>
            <Video
              src={staticFile(input.masterVideoSrc)}
              muted
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
            <CursorOverlay
              cx={cursor.cx}
              cy={cursor.cy}
              flashAmount={flashAmount}
              counterScale={1}
            />
          </>
        )}
      </div>

      {/* One Sequence per narrator beat. The narrator picked startS + durS
          based on the moment timeline, so each spoken line lands EXACTLY
          when the corresponding visual moment happens. Chunks are
          guaranteed non-overlapping by the editor's normaliseBeats step. */}
      {input.bodyChunks.map((c, i) => {
        const startFrame = Math.round(c.startS * fps);
        const durFrames = Math.max(1, Math.round(c.durS * fps));
        return (
          <Sequence key={`chunk-${i}`} from={startFrame} durationInFrames={durFrames} layout="none">
            {c.voiceSrc && (
              <Audio
                src={staticFile(c.voiceSrc)}
                volume={1.1}
                playbackRate={c.voicePlaybackRate ?? 1}
              />
            )}
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 240 }}>
              <WordCaption
                text={c.text}
                durationInFrames={durFrames}
                fps={fps}
                accent="#00e5a0"
                voiceDurS={c.voiceDurS ? c.voiceDurS / (c.voicePlaybackRate ?? 1) : undefined}
                voiceStartDelayS={0.05}
              />
            </div>
          </Sequence>
        );
      })}

      {/* Overlay badges for silent investigative moments. Each pinned to
          its tool window's body-relative timestamp — independent of the
          narration audio, so they never desync with the on-screen action. */}
      {(input.bodyBadges ?? []).map((b, i) => {
        const startFrame = Math.round(b.startS * fps);
        const durFrames = Math.max(1, Math.round(b.durS * fps));
        return (
          <Sequence key={`badge-${i}`} from={startFrame} durationInFrames={durFrames} layout="none">
            <ToolBadge label={b.label} detail={b.detail} />
          </Sequence>
        );
      })}

      {/* Verification stamps — animated check / cross / dash at the exact
          moment each goal was decided by the agent. Lives 1.8s. Pinned to
          body-relative seconds so it tracks the trimmed timeline exactly. */}
      {(input.verificationStamps ?? []).map((s, i) => {
        const STAMP_DUR_S = 1.8;
        const startFrame = Math.round(s.atS * fps);
        const durFrames = Math.max(1, Math.round(STAMP_DUR_S * fps));
        return (
          <Sequence key={`vstamp-${i}`} from={startFrame} durationInFrames={durFrames} layout="none">
            <VerificationStamp outcome={s.outcome} label={s.label} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * Pointer + click flash drawn on top of the recording. Lives inside the
 * pan-zoom transform so the cursor tracks the zoomed page coordinates
 * exactly. The SVG counter-scales to keep its on-screen size constant as
 * the parent scales up/down. The pointer's tip (viewBox 3,2) is pinned
 * EXACTLY to (cx, cy) — without this the click ring lands a few pixels
 * off-target and the visual contract ("cursor is on the thing it clicks")
 * breaks down on zoom-in.
 */
const CursorOverlay: React.FC<{
  cx: number;
  cy: number;
  flashAmount: number; // 0 → 1, peaks at the click moment
  counterScale: number;
}> = ({ cx, cy, flashAmount, counterScale }) => {
  // Smaller cursor than v1: 32px nominal vs the previous 56px. Roughly
  // matches a real OS cursor at the recording's effective scale.
  const NOMINAL = 32;
  const cursorSize = NOMINAL * counterScale;
  // SVG viewBox tip at (3, 2) inside a 28×28 box. Map to pixel offsets in
  // the rendered SVG so we can offset the SVG so its tip sits at (cx, cy).
  const tipX = cursorSize * (3 / 28);
  const tipY = cursorSize * (2 / 28);
  const ringScale = 0.5 + flashAmount * 1.4;
  const ringOpacity = flashAmount * 0.85;
  return (
    <>
      {flashAmount > 0.02 && (
        <div
          style={{
            position: "absolute",
            left: cx,
            top: cy,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -90 * counterScale,
              top: -90 * counterScale,
              width: 180 * counterScale,
              height: 180 * counterScale,
              borderRadius: "50%",
              border: `${5 * counterScale}px solid #00e5a0`,
              transform: `scale(${ringScale})`,
              opacity: ringOpacity,
              boxShadow: `0 0 ${44 * counterScale}px #00e5a0`,
            }}
          />
        </div>
      )}
      <svg
        viewBox="0 0 28 28"
        width={cursorSize}
        height={cursorSize}
        style={{
          position: "absolute",
          left: cx - tipX,
          top: cy - tipY,
          filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.6))",
          pointerEvents: "none",
        }}
      >
        <path
          d="M3 2 L3 22 L8.5 17 L12 25 L15 23.5 L11.5 15.5 L19 15.5 Z"
          fill="#ffffff"
          stroke="#0a0a0a"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};
