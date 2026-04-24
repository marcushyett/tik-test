"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Keyboard, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { Button } from "./ui/button";
import { PRHeader } from "./pr-header";
import { DecisionForm } from "./decision-form";
import { CommentList } from "./comment-list";
import { PRBodyPreview } from "./pr-body-preview";
import { MobileDrawer } from "./mobile-drawer";
import { proxyMedia } from "@/lib/utils";
import type { OpenPR } from "@/lib/github";
import type { TikTestVideo } from "@/lib/marker";

type FeedItem = { pr: OpenPR; video: TikTestVideo };

function flatten(prs: OpenPR[]): FeedItem[] {
  return prs.map((pr) => ({ pr, video: pr.videos[0]! })).filter((x) => !!x.video);
}

export function VideoFeed({ repo, prs }: { repo: { owner: string; name: string }; prs: OpenPR[] }) {
  const items = flatten(prs);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [posted, setPosted] = useState(false);
  // Mobile browsers refuse to autoplay videos with sound — the <video> tag
  // only starts playing if `muted` is true on first mount. We start every
  // mount muted, expose a tap-to-unmute chip, and remember the user's choice
  // across feed navigations so they don't have to re-tap on every PR.
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const current = items[idx];

  // Pause the currently-mounted video before changing idx so that — even if
  // React's unmount is slow — no audio leaks into the new video's playback.
  const pauseCurrent = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      try { v.pause(); v.currentTime = 0; } catch {}
    }
  }, []);

  const goNext = useCallback(() => {
    pauseCurrent();
    setPosted(false);
    setPlaying(true);
    setIdx((i) => Math.min(items.length, i + 1));
  }, [items.length, pauseCurrent]);

  const goPrev = useCallback(() => {
    pauseCurrent();
    setPosted(false);
    setPlaying(true);
    setIdx((i) => Math.max(0, i - 1));
  }, [pauseCurrent]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      const v = videoRef.current;
      if (v) {
        v.muted = next;
        // Calling play() inside the same user-gesture callback satisfies the
        // autoplay policy and lets the now-unmuted track start producing audio.
        if (!next) void v.play().catch(() => {});
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); goPrev(); }
      else if (e.key === "m" || e.key === "M") { e.preventDefault(); toggleMute(); }
      else if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current; if (!v) return;
        if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
      }
      else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const v = videoRef.current; if (!v) return;
        v.currentTime = Math.max(0, v.currentTime - 5);
      }
      else if (e.key === "ArrowRight") {
        e.preventDefault();
        const v = videoRef.current; if (!v) return;
        const dur = Number.isFinite(v.duration) ? v.duration : v.currentTime + 5;
        v.currentTime = Math.min(dur, v.currentTime + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, toggleMute]);

  if (items.length === 0) return <EmptyState repo={repo} />;
  if (idx >= items.length) return <InboxZero onRestart={() => setIdx(0)} />;

  const { pr, video } = current;
  const videoSrc = proxyMedia(video.videoUrl);
  const gifSrc = video.gifUrl ? proxyMedia(video.gifUrl) : undefined;

  // Shared decision form — available immediately, not gated on video end.
  const decision = (
    <DecisionForm
      repo={repo}
      prNumber={pr.number}
      prTitle={pr.title}
      onDone={() => { setPosted(true); setTimeout(goNext, 600); }}
      onSkip={goNext}
      onPause={() => { videoRef.current?.pause(); setPlaying(false); }}
      isPosted={posted}
    />
  );

  const sidebar = (
    <div className="flex flex-col gap-5">
      <PRHeader repo={repo} pr={pr} />
      {decision}
      <PRBodyPreview body={pr.body} defaultOpen={false} />
      <div>
        <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Existing comments
        </div>
        <CommentList comments={pr.comments} />
      </div>
    </div>
  );

  return (
    <>
      {/* ========== Desktop: two-column. Hidden on mobile. ========== */}
      <div className="hidden h-[calc(100dvh-80px)] md:grid md:grid-cols-[minmax(0,420px)_minmax(0,1fr)] md:gap-8 md:px-6 md:pb-10">
        {/* Video column */}
        <div className="flex min-h-0 flex-col gap-3">
          <FeedCounter idx={idx} total={items.length} video={video} />
          <VideoFrame
            ref={videoRef}
            src={videoSrc}
            poster={gifSrc}
            playing={playing}
            setPlaying={setPlaying}
            muted={muted}
            onToggleMute={toggleMute}
            onPrev={goPrev}
            onNext={goNext}
            aspect="9/16"
          />
          <KeyboardHint onSkip={goNext} />
        </div>
        {/* Scrollable right column */}
        <div className="min-h-0 overflow-y-auto pr-1 pb-10">{sidebar}</div>
      </div>

      {/* ========== Mobile: fullscreen video + bottom drawer ========== */}
      <div className="relative h-[100dvh] w-full overflow-hidden md:hidden">
        <VideoFrame
          ref={videoRef}
          src={videoSrc}
          poster={gifSrc}
          playing={playing}
          setPlaying={setPlaying}
          muted={muted}
          onToggleMute={toggleMute}
          onPrev={goPrev}
          onNext={goNext}
          aspect="fill"
        />

        {/* Top overlay with counter — doesn't obscure the app UI in the video. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 via-black/30 to-transparent p-4 pt-[max(1rem,env(safe-area-inset-top))] text-xs text-white/90">
          <span className="font-mono tracking-widest">
            {idx + 1}/{items.length}
          </span>
          <span className="rounded-full border border-white/20 bg-black/40 px-2 py-0.5 font-mono text-[10px] backdrop-blur">
            {video.stats.passed}/{video.stats.total} green · {video.stats.failed} oops
          </span>
        </div>

        {/* Tap-to-unmute chip — mobile needs this hard. Browsers block autoplay
            with sound, so our only option is to mount muted and let the user
            turn audio on with one tap. Anchored top-center so it's visible the
            instant the video starts. */}
        {muted && (
          <button
            type="button"
            onClick={toggleMute}
            className="absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-md transition active:scale-95"
            aria-label="Unmute audio"
          >
            <span className="inline-flex items-center gap-2">
              <VolumeX className="h-4 w-4" />
              Tap to unmute
            </span>
          </button>
        )}

        {/* Right-edge swipe buttons (always reachable with the thumb). */}
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col gap-2">
          <Button size="icon" variant="secondary" className="h-10 w-10 bg-black/60 backdrop-blur-sm hover:bg-black/80" onClick={goPrev} aria-label="Previous PR">
            <ChevronUp className="h-5 w-5" />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            className="h-10 w-10 bg-black/60 backdrop-blur-sm hover:bg-black/80"
            onClick={toggleMute}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </Button>
          <Button size="icon" variant="secondary" className="h-10 w-10 bg-black/60 backdrop-blur-sm hover:bg-black/80" onClick={goNext} aria-label="Next PR">
            <ChevronDown className="h-5 w-5" />
          </Button>
        </div>

        <MobileDrawer pr={pr} repo={repo}>
          {sidebar}
        </MobileDrawer>
      </div>
    </>
  );
}

/* --------------------------- sub-components --------------------------- */

function FeedCounter({ idx, total, video }: { idx: number; total: number; video: TikTestVideo }) {
  return (
    <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
      <span>PR {idx + 1} of {total}</span>
      <span>{video.stats.passed}/{video.stats.total} green · {video.stats.failed} oops</span>
    </div>
  );
}

const VideoFrame = (() => {
  const Inner = (
    {
      src, poster, playing, setPlaying, muted, onToggleMute, onPrev, onNext, aspect,
    }: {
      src: string;
      poster?: string;
      playing: boolean;
      setPlaying: (v: boolean) => void;
      muted: boolean;
      onToggleMute: () => void;
      onPrev: () => void;
      onNext: () => void;
      aspect: "9/16" | "fill";
    },
    ref: React.Ref<HTMLVideoElement>,
  ) => {
    const videoRef = ref as React.RefObject<HTMLVideoElement>;
    const wrapClass = aspect === "9/16"
      ? "group relative flex-1 min-h-0 overflow-hidden rounded-2xl border border-border bg-black shadow-lift"
      : "absolute inset-0 bg-black";

    const togglePlay = (e?: React.MouseEvent | React.KeyboardEvent) => {
      e?.stopPropagation();
      const v = videoRef.current; if (!v) return;
      if (v.paused) { void v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
    };
    const skip = (delta: number) => (e: React.MouseEvent) => {
      e.stopPropagation();
      const v = videoRef.current; if (!v) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      v.currentTime = Math.max(0, Math.min(dur || v.currentTime + delta, v.currentTime + delta));
    };

    return (
      <div className={wrapClass} style={aspect === "9/16" ? { aspectRatio: "9 / 16" } : undefined}>
        {/* key={src} forces React to unmount the previous video element when
            the src changes. Without it React reuses the element, the browser
            keeps the old audio track alive while loading the new src, and
            scrolling fast between PRs produces overlapping voices. */}
        <video
          key={src}
          ref={ref}
          src={src}
          poster={poster}
          autoPlay
          muted
          playsInline
          preload="auto"
          className="h-full w-full cursor-pointer object-contain"
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />

        {/* Custom control bar — bottom of the frame. Unlike native controls
            this lives inside our UI and stays consistent across browsers. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3">
          <div className="pointer-events-auto flex items-center gap-1.5">
            <Button
              size="icon"
              variant="secondary"
              className="h-9 w-9 bg-black/60 backdrop-blur-sm hover:bg-black/80"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="h-9 w-9 bg-black/60 backdrop-blur-sm hover:bg-black/80"
              onClick={skip(-5)}
              aria-label="Skip back 5 seconds"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="h-9 w-9 bg-black/60 backdrop-blur-sm hover:bg-black/80"
              onClick={skip(5)}
              aria-label="Skip forward 5 seconds"
            >
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="h-9 w-9 bg-black/60 backdrop-blur-sm hover:bg-black/80"
              onClick={(e) => { e.stopPropagation(); onToggleMute(); }}
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
          </div>
          {aspect === "9/16" && (
            <div className="pointer-events-auto flex items-center gap-1.5">
              <Button
                size="icon"
                variant="secondary"
                className="h-9 w-9 bg-black/60 backdrop-blur-sm hover:bg-black/80"
                onClick={(e) => { e.stopPropagation(); onPrev(); }}
                aria-label="Previous PR"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                className="h-9 w-9 bg-black/60 backdrop-blur-sm hover:bg-black/80"
                onClick={(e) => { e.stopPropagation(); onNext(); }}
                aria-label="Next PR"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {/* Big centred play button when paused — lets the viewer restart a
            video that ended or paused from elsewhere without aiming for the
            small bar at the bottom. */}
        {!playing && (
          <button
            type="button"
            aria-label="Play video"
            onClick={togglePlay}
            className="absolute inset-0 flex items-center justify-center bg-black/10 transition hover:bg-black/20"
          >
            <span className="rounded-full bg-black/70 p-4 backdrop-blur-sm">
              <Play className="h-10 w-10 text-white" />
            </span>
          </button>
        )}
      </div>
    );
  };
  return Object.assign(
    ({ children: _c, ...p }: any, ref?: any) => Inner(p, ref),
    { displayName: "VideoFrame" },
  ) as unknown as React.ForwardRefExoticComponent<any>;
})();

function KeyboardHint({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Keyboard className="h-3.5 w-3.5" />
        <Kbd>↑</Kbd><Kbd>↓</Kbd> navigate · <Kbd>←</Kbd><Kbd>→</Kbd> skip 5s · <Kbd>space</Kbd> pause · <Kbd>m</Kbd> mute
      </span>
      <Button variant="ghost" size="sm" onClick={onSkip}>Skip →</Button>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground">{children}</kbd>;
}

function EmptyState({ repo }: { repo: { owner: string; name: string } }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-xl font-semibold tracking-tight">Nothing to review yet</div>
      <p className="text-sm text-muted-foreground">
        tik-test hasn't posted a video on any open PR in{" "}
        <span className="font-mono">{repo.owner}/{repo.name}</span>. Run{" "}
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">tik-test pr &lt;number&gt;</span>{" "}
        or wire up the GitHub Action.
      </p>
    </div>
  );
}

function InboxZero({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <CheckCircle2 className="h-10 w-10 text-primary" strokeWidth={1.5} />
      <div className="text-2xl font-semibold tracking-tight">Inbox zero.</div>
      <p className="text-sm text-muted-foreground">You've worked through every tik-test review in this repo.</p>
      <Button variant="outline" onClick={onRestart}>Back to the top</Button>
    </div>
  );
}
