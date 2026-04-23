"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { PRHeader } from "./pr-header";
import { DecisionForm } from "./decision-form";
import { CommentList } from "./comment-list";
import { PRBodyPreview } from "./pr-body-preview";
import { Button } from "./ui/button";
import type { OpenPR } from "@/lib/github";
import type { TikTestVideo } from "@/lib/marker";

interface Props {
  repo: { owner: string; name: string };
  prs: OpenPR[];
}

type FeedItem = { pr: OpenPR; video: TikTestVideo };

function flatten(prs: OpenPR[]): FeedItem[] {
  // One feed entry per (PR × newest video). Keeping it to newest-video-per-PR
  // so the reviewer can blast through 50 PRs, not 50 × revisions.
  return prs.map((pr) => ({ pr, video: pr.videos[0]! })).filter((x) => !!x.video);
}

export function VideoFeed({ repo, prs }: Props) {
  const items = flatten(prs);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<"watching" | "deciding" | "posted">("watching");
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);

  const current = items[idx];

  const goNext = useCallback(() => {
    setPhase("watching");
    setIdx((i) => Math.min(items.length, i + 1));
  }, [items.length]);
  const goPrev = useCallback(() => {
    setPhase("watching");
    setIdx((i) => Math.max(0, i - 1));
  }, []);

  // Keyboard shortcuts: ↑ / ↓ / j / k / Space / Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); goPrev(); }
      else if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current; if (!v) return;
        if (v.paused) v.play(); else v.pause();
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

  if (items.length === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-center">
        <div className="text-lg font-semibold">Nothing to review yet.</div>
        <p className="max-w-md text-sm text-muted-foreground">
          tik-test hasn't posted a video on any open PR in {repo.owner}/{repo.name}. Run
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-[0.8em]">tik-test pr &lt;number&gt;</code>
          or wire up the GitHub Action to auto-generate reviews.
        </p>
      </div>
    );
  }

  if (idx >= items.length) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <div className="text-2xl font-semibold">Inbox zero ✨</div>
        <p className="max-w-md text-sm text-muted-foreground">
          You've worked through every tik-test review on {repo.owner}/{repo.name}.
        </p>
        <Button variant="outline" onClick={() => setIdx(0)}>Back to the top</Button>
      </div>
    );
  }

  const { pr, video } = current;

  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col gap-4 px-4 pb-16">
      <PRHeader repo={repo} pr={pr} />

      <div className="relative overflow-hidden rounded-2xl border bg-black" style={{ aspectRatio: "9 / 16" }}>
        <video
          ref={videoRef}
          src={video.videoUrl}
          poster={video.gifUrl}
          autoPlay
          playsInline
          controls={phase === "watching"}
          className="h-full w-full object-contain"
          onEnded={() => setPhase("deciding")}
          key={video.runId + String(idx)}
        />
        {phase === "watching" && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-2">
            <Button size="icon" variant="secondary" onClick={goPrev} aria-label="Previous PR"><ChevronUp className="h-5 w-5" /></Button>
            <div className="text-xs text-muted-foreground">#{idx + 1} of {items.length} · {video.stats.passed}/{video.stats.total} passed</div>
            <Button size="icon" variant="secondary" onClick={goNext} aria-label="Next PR"><ChevronDown className="h-5 w-5" /></Button>
          </div>
        )}
      </div>

      {phase === "deciding" && (
        <DecisionForm
          repo={repo}
          prNumber={pr.number}
          prTitle={pr.title}
          onDone={() => {
            setReviewed((s) => new Set(s).add(`${pr.number}`));
            setPhase("posted");
            setTimeout(goNext, 600);
          }}
          onSkip={goNext}
        />
      )}

      {phase === "posted" && (
        <div className="rounded-xl border border-primary/40 bg-primary/10 p-4 text-sm">Posted — cueing next PR…</div>
      )}

      <PRBodyPreview body={pr.body} />

      <div>
        <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Other comments</div>
        <CommentList comments={pr.comments} />
      </div>
    </div>
  );
}
