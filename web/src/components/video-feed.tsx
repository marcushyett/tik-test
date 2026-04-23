"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Keyboard, PauseCircle, PlayCircle } from "lucide-react";
import { Button } from "./ui/button";
import { PRHeader } from "./pr-header";
import { DecisionForm } from "./decision-form";
import { CommentList } from "./comment-list";
import { PRBodyPreview } from "./pr-body-preview";
import type { OpenPR } from "@/lib/github";
import type { TikTestVideo } from "@/lib/marker";

type FeedItem = { pr: OpenPR; video: TikTestVideo };

function flatten(prs: OpenPR[]): FeedItem[] {
  // Keep it to newest-video-per-PR so a reviewer can blast through 50 PRs,
  // not 50 × revisions of the same PR.
  return prs.map((pr) => ({ pr, video: pr.videos[0]! })).filter((x) => !!x.video);
}

export function VideoFeed({ repo, prs }: { repo: { owner: string; name: string }; prs: OpenPR[] }) {
  const items = flatten(prs);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<"watching" | "deciding" | "posted">("watching");
  const [playing, setPlaying] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const current = items[idx];

  const goNext = useCallback(() => {
    setPhase("watching");
    setPlaying(true);
    setIdx((i) => Math.min(items.length, i + 1));
  }, [items.length]);

  const goPrev = useCallback(() => {
    setPhase("watching");
    setPlaying(true);
    setIdx((i) => Math.max(0, i - 1));
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); goPrev(); }
      else if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current; if (!v) return;
        if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev]);

  // When the video ends, flip into decision mode.
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onEnded = () => setPhase("deciding");
    v.addEventListener("ended", onEnded);
    return () => v.removeEventListener("ended", onEnded);
  }, [idx]);

  if (items.length === 0) return <EmptyState repo={repo} />;
  if (idx >= items.length) return <InboxZero onRestart={() => setIdx(0)} />;

  const { pr, video } = current;

  return (
    <div className="mx-auto grid w-full max-w-[1080px] gap-8 px-4 pb-20 md:grid-cols-[420px_minmax(0,1fr)]">
      {/* Left column: the TikTok-style video + decision. */}
      <div className="flex flex-col gap-4 md:sticky md:top-6 md:self-start">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          <span>PR {idx + 1} of {items.length}</span>
          <span>{video.stats.passed}/{video.stats.total} green · {video.stats.failed} oops</span>
        </div>

        <div
          className="group relative overflow-hidden rounded-2xl border border-border bg-black shadow-lift"
          style={{ aspectRatio: "9 / 16" }}
          onClick={() => {
            const v = videoRef.current; if (!v) return;
            if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
          }}
        >
          <video
            ref={videoRef}
            src={video.videoUrl}
            poster={video.gifUrl}
            autoPlay
            playsInline
            controls={phase === "watching"}
            className="h-full w-full object-contain"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPhase("deciding")}
            key={video.runId + String(idx)}
          />
          {/* Top gradient shows the counter always. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 to-transparent" />
          {/* Pause overlay — only when actually paused. */}
          {!playing && phase === "watching" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
              <PlayCircle className="h-14 w-14 text-white/90 drop-shadow-lg" />
            </div>
          )}
          {/* Subtle chevrons only appear on hover. */}
          {phase === "watching" && (
            <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-2 pr-2 opacity-0 transition-opacity group-hover:opacity-100">
              <Button
                size="icon"
                variant="secondary"
                className="pointer-events-auto h-10 w-10 bg-black/60 backdrop-blur-sm hover:bg-black/80"
                onClick={(e) => { e.stopPropagation(); goPrev(); }}
                aria-label="Previous PR"
              >
                <ChevronUp className="h-5 w-5" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                className="pointer-events-auto h-10 w-10 bg-black/60 backdrop-blur-sm hover:bg-black/80"
                onClick={(e) => { e.stopPropagation(); goNext(); }}
                aria-label="Next PR"
              >
                <ChevronDown className="h-5 w-5" />
              </Button>
            </div>
          )}
        </div>

        {/* Keyboard hint strip. */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Keyboard className="h-3.5 w-3.5" />
            <Kbd>↑</Kbd><Kbd>↓</Kbd> navigate · <Kbd>space</Kbd> pause
          </span>
          <Button variant="ghost" size="sm" onClick={goNext}>Skip →</Button>
        </div>

        {phase === "deciding" && (
          <DecisionForm
            repo={repo}
            prNumber={pr.number}
            prTitle={pr.title}
            onDone={() => {
              setPhase("posted");
              setTimeout(goNext, 550);
            }}
            onSkip={goNext}
          />
        )}

        {phase === "posted" && (
          <div className="fade-up glass rounded-2xl border-primary/40 bg-primary/10 p-4 text-sm text-primary">
            Review posted. Cueing next PR…
          </div>
        )}
      </div>

      {/* Right column: PR meta so the reviewer sees context while deciding. */}
      <div className="flex flex-col gap-6">
        <PRHeader repo={repo} pr={pr} />

        <PRBodyPreview body={pr.body} />

        <div>
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Existing reviewer comments
          </div>
          <CommentList comments={pr.comments} />
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground">{children}</kbd>;
}

function EmptyState({ repo }: { repo: { owner: string; name: string } }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60">
        <PauseCircle className="h-7 w-7 text-muted-foreground" />
      </div>
      <div>
        <div className="text-xl font-semibold tracking-tight">Nothing to review yet</div>
        <p className="mt-2 text-sm text-muted-foreground">
          tik-test hasn't posted a video on any open PR in
          <span className="mx-1 font-mono">{repo.owner}/{repo.name}</span>.
          Run <span className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">tik-test pr &lt;number&gt;</span>
          or wire up the GitHub Action so reviews land here automatically.
        </p>
      </div>
    </div>
  );
}

function InboxZero({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-5xl">🎉</div>
      <div className="text-2xl font-semibold tracking-tight">Inbox zero.</div>
      <p className="text-sm text-muted-foreground">
        You've worked through every tik-test review in this repo. Ship it, or come back when there's a new build.
      </p>
      <Button variant="outline" onClick={onRestart}>Back to the top</Button>
    </div>
  );
}
