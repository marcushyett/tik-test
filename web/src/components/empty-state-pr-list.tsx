"use client";

/**
 * Triage dashboard rendered in the video feed's empty / caught-up states.
 *
 * The video feed is the primary surface — but when there are no videos to
 * watch (either none exist yet, or every one has been seen on this device),
 * a blank screen is the wrong answer. This component fills the gap with a
 * compact list of every open PR plus the four signals that decide
 * "is this safe to merge":
 *
 *   AI review · CI · peer reviews · mergeable
 *
 * Each row carries a Merge button. Clicking it opens an inline confirm step
 * that re-states the four signals — a deliberate friction point so a tired
 * reviewer doesn't ship an unreviewed PR by reflex. The merge call goes
 * through the same auth as posting reviews, with the same hard refusal on
 * test-bypass sessions (see lib/github.ts: submitMerge).
 */

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, GitMerge, Loader2, MessageSquare, ShieldAlert, ThumbsUp, Video, XCircle } from "lucide-react";
import type { OpenPR } from "@/lib/github";
import { submitMergeAction } from "@/app/actions";
import { Button } from "./ui/button";

interface Props {
  prs: OpenPR[];
  repo: { owner: string; name: string };
  /** Heading the dashboard renders under. The video-feed customizes the
   *  copy depending on whether we got here via "no videos at all" vs
   *  "every video already seen". */
  heading: string;
  subheading?: string;
}

export function EmptyStatePRList({ prs, repo, heading, subheading }: Props) {
  if (prs.length === 0) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <CheckCircle2 className="h-10 w-10 text-primary" strokeWidth={1.5} />
        <div className="text-2xl font-semibold tracking-tight">{heading}</div>
        {subheading && <p className="text-sm text-muted-foreground">{subheading}</p>}
        <p className="text-sm text-muted-foreground">No open PRs in this repo right now.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col gap-4 px-4 pb-12 pt-6 md:px-6">
      <header className="flex flex-col gap-1 text-center md:text-left">
        <div className="text-2xl font-semibold tracking-tight">{heading}</div>
        {subheading && <p className="text-sm text-muted-foreground">{subheading}</p>}
        <p className="text-xs text-muted-foreground">
          {prs.length} open PR{prs.length === 1 ? "" : "s"} in{" "}
          <span className="font-mono">{repo.owner}/{repo.name}</span>. Status flags below — merge inline
          or open a PR to review further.
        </p>
      </header>
      <ul className="flex flex-col gap-3">
        {prs.map((pr) => (
          <PRRow key={pr.number} pr={pr} repo={repo} />
        ))}
      </ul>
    </div>
  );
}

function PRRow({ pr, repo }: { pr: OpenPR; repo: { owner: string; name: string } }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ kind: "ok"; sha?: string } | { kind: "err"; message: string } | null>(null);

  const aiStatus = aiReviewStatus(pr);
  const reviewsStatus = peerReviewStatus(pr);
  const mergeBlocked = pr.mergeable !== "clean" || pr.reviews.changesRequested > 0;

  const onConfirm = () => {
    setResult(null);
    startTransition(async () => {
      const res = await submitMergeAction({
        owner: repo.owner,
        repo: repo.name,
        number: pr.number,
        expectedHeadSha: pr.headSha,
      });
      if (res.ok) {
        setResult({ kind: "ok", sha: res.sha });
        setConfirming(false);
      } else {
        setResult({ kind: "err", message: res.error });
      }
    });
  };

  return (
    <li className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={pr.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-baseline gap-1.5 text-[15px] font-semibold leading-tight tracking-tight text-foreground hover:text-primary"
          >
            <span className="line-clamp-1">{pr.title}</span>
            <ExternalLink className="relative top-0.5 h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-80" />
          </a>
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="font-mono">#{pr.number}</span>
            {" · "}
            <span>by @{pr.author.login}</span>
          </div>
        </div>
        {result?.kind === "ok" ? (
          <span className="inline-flex h-9 items-center gap-1 rounded-md bg-primary/15 px-3 text-xs font-medium text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" /> Merged
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={mergeBlocked || pending}
            variant={mergeBlocked ? "secondary" : "default"}
            onClick={() => setConfirming(true)}
            title={mergeBlocked ? "Resolve merge conflicts or required changes first." : undefined}
          >
            <GitMerge className="mr-1.5 h-3.5 w-3.5" />
            Merge
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <StatusPill kind="ai" status={aiStatus} />
        <StatusPill kind="ci" status={pr.ciState} />
        <StatusPill kind="reviews" status={reviewsStatus} approvals={pr.reviews.approvals} blocking={pr.reviews.changesRequested} />
        <StatusPill kind="merge" status={pr.mergeable} />
      </div>

      {confirming && (
        <ConfirmRow
          pr={pr}
          aiStatus={aiStatus}
          reviewsStatus={reviewsStatus}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirm}
          error={result?.kind === "err" ? result.message : undefined}
        />
      )}
    </li>
  );
}

function ConfirmRow({
  pr,
  aiStatus,
  reviewsStatus,
  pending,
  onCancel,
  onConfirm,
  error,
}: {
  pr: OpenPR;
  aiStatus: AIStatus;
  reviewsStatus: ReviewsStatus;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  error?: string;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-2 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(45,100%,64%)]" />
        <div className="flex-1">
          <div className="font-medium">Merge PR #{pr.number}?</div>
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="font-mono">{pr.title.slice(0, 60)}{pr.title.length > 60 ? "…" : ""}</span>
            <br />
            AI review: <strong>{describeAI(aiStatus)}</strong>
            {" · "}
            CI: <strong>{pr.ciState === "success" ? "green" : pr.ciState === "failure" || pr.ciState === "error" ? "red" : pr.ciState}</strong>
            {" · "}
            Reviews: <strong>{describeReviews(reviewsStatus, pr.reviews.approvals, pr.reviews.changesRequested)}</strong>
            {" · "}
            Mergeable: <strong>{pr.mergeable}</strong>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {error && <span className="mr-auto text-xs text-destructive">{error}</span>}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onConfirm} disabled={pending}>
          {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <GitMerge className="mr-1.5 h-3.5 w-3.5" />}
          Confirm merge
        </Button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 * Status pill + helpers — keep visuals consistent with PRHeader.
 * ──────────────────────────────────────────────────────────── */

type AIStatus = "passed" | "failed" | "none";
type ReviewsStatus = "approved" | "blocking" | "none";

function aiReviewStatus(pr: OpenPR): AIStatus {
  if (pr.videos.length === 0) return "none";
  const latest = pr.videos[0];
  if (latest.stats.failed > 0) return "failed";
  return "passed";
}

function peerReviewStatus(pr: OpenPR): ReviewsStatus {
  if (pr.reviews.changesRequested > 0) return "blocking";
  if (pr.reviews.approvals > 0) return "approved";
  return "none";
}

function describeAI(s: AIStatus): string {
  return s === "passed" ? "passed" : s === "failed" ? "had failures" : "no review yet";
}

function describeReviews(s: ReviewsStatus, approvals: number, blocking: number): string {
  if (s === "blocking") return `${blocking} blocking`;
  if (s === "approved") return `${approvals} approval${approvals === 1 ? "" : "s"}`;
  return "none";
}

function StatusPill({
  kind,
  status,
  approvals,
  blocking,
}: {
  kind: "ai" | "ci" | "reviews" | "merge";
  status: AIStatus | OpenPR["ciState"] | ReviewsStatus | OpenPR["mergeable"];
  approvals?: number;
  blocking?: number;
}) {
  const { tone, icon: Icon, label, animate } = pillSpec(kind, status, approvals, blocking);
  const toneClass =
    tone === "positive"
      ? "text-primary bg-primary/10 border-primary/20"
      : tone === "negative"
      ? "text-destructive bg-destructive/10 border-destructive/20"
      : tone === "warn"
      ? "text-[hsl(45,100%,64%)] bg-[hsl(45,100%,64%)_/_0.1] border-[hsl(45,100%,64%)_/_0.2]"
      : "text-muted-foreground bg-muted/40 border-border";
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-[10.5px] ${toneClass}`}>
      <Icon className={`h-3 w-3 ${animate ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}

type Tone = "positive" | "negative" | "warn" | "muted";
type Spec = { tone: Tone; icon: React.ComponentType<{ className?: string }>; label: string; animate?: boolean };

function pillSpec(
  kind: "ai" | "ci" | "reviews" | "merge",
  status: any,
  approvals?: number,
  blocking?: number,
): Spec {
  if (kind === "ai") {
    if (status === "passed") return { tone: "positive", icon: Video, label: "ai passed" };
    if (status === "failed") return { tone: "negative", icon: Video, label: "ai failed" };
    return { tone: "muted", icon: Video, label: "no ai review" };
  }
  if (kind === "ci") {
    if (status === "success") return { tone: "positive", icon: CheckCircle2, label: "ci green" };
    if (status === "failure" || status === "error") return { tone: "negative", icon: XCircle, label: "ci red" };
    if (status === "pending") return { tone: "warn", icon: Clock, label: "ci pending", animate: true };
    return { tone: "muted", icon: Clock, label: "ci unknown" };
  }
  if (kind === "reviews") {
    if (status === "blocking") return { tone: "negative", icon: MessageSquare, label: `${blocking ?? 0} blocking` };
    if (status === "approved") return { tone: "positive", icon: ThumbsUp, label: `${approvals ?? 0} approved` };
    return { tone: "muted", icon: MessageSquare, label: "no reviews" };
  }
  // merge
  if (status === "clean") return { tone: "positive", icon: GitMerge, label: "no conflicts" };
  if (status === "conflicting") return { tone: "negative", icon: AlertTriangle, label: "conflicts" };
  if (status === "checking") return { tone: "muted", icon: Clock, label: "merge: checking", animate: true };
  return { tone: "muted", icon: GitMerge, label: "merge: unknown" };
}
