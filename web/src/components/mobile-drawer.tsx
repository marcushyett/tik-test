"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Clock, GitMerge, GripHorizontal, Loader2, Minus, Plus, ShieldAlert, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { AIChecksBadge } from "./ai-checks-list";
import { Button } from "./ui/button";
import { submitMergeAction } from "@/app/actions";
import type { OpenPR } from "@/lib/github";
import type { ChecklistItem } from "@/lib/marker";

/**
 * Bottom-sheet drawer for mobile. Two states:
 *  - peek: short pill at the bottom showing PR title + key metrics. Tappable
 *          to expand. Doesn't obscure the video.
 *  - expanded: nearly-full-height sheet with scrollable content inside.
 *
 * No external dependency (vaul, radix-dialog) — this is 80 lines of pointer
 * math that gives a crisp one-handed drag-to-dismiss feel.
 */
export function MobileDrawer({
  pr,
  repo,
  checklist,
  children,
}: {
  pr: OpenPR;
  repo: { owner: string; name: string };
  /** AI-checks list from the marker — surfaced as a small badge on the
   *  collapsed peek pill so reviewers see pass/fail counts at a glance. */
  checklist?: ChecklistItem[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Cross-surface merge flow: clicking Merge from the peek pill opens the
  // drawer AND surfaces the confirm card; clicking Merge from the expanded
  // sheet does the same minus the open. Either way, confirm/cancel/result
  // state lives at this level so the same flow is shared.
  const [mergeConfirming, setMergeConfirming] = useState(false);
  const [mergeResult, setMergeResult] = useState<
    | { kind: "ok"; sha?: string }
    | { kind: "err"; message: string }
    | null
  >(null);
  const [merging, startMerge] = useTransition();

  // Mergeability gate matches the empty-state triage's gate (see
  // empty-state-pr-list.tsx) so the user gets the same rule everywhere:
  // Merge is only offered when there are no conflicts AND no peer reviewer
  // is currently requesting changes. The button is hidden (not greyed) on
  // the peek pill when ineligible — the peek is space-constrained and a
  // dead button there reads like clutter. The expanded sheet shows it
  // disabled with a tooltip so the user can see WHY it can't fire.
  const mergeEligible = pr.mergeable === "clean" && pr.reviews.changesRequested === 0;
  const mergeBlockedReason =
    pr.mergeable === "conflicting" ? "Merge conflicts — resolve first."
    : pr.mergeable === "checking" ? "GitHub is still computing mergeability."
    : pr.reviews.changesRequested > 0 ? `${pr.reviews.changesRequested} blocking review${pr.reviews.changesRequested === 1 ? "" : "s"} — address first.`
    : pr.mergeable !== "clean" ? "Mergeable status unknown."
    : null;

  const onConfirmMerge = () => {
    setMergeResult(null);
    startMerge(async () => {
      const res = await submitMergeAction({
        owner: repo.owner,
        repo: repo.name,
        number: pr.number,
        expectedHeadSha: pr.headSha,
      });
      if (res.ok) {
        setMergeResult({ kind: "ok", sha: res.sha });
        setMergeConfirming(false);
      } else {
        setMergeResult({ kind: "err", message: res.error });
      }
    });
  };

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Drag-to-dismiss: track pointer vertical delta on the grabber. We also
  // remember whether the pointer actually moved — a drag with zero motion
  // is treated as a tap, which closes the drawer (so the grabber has both
  // affordances: drag-down OR tap).
  const startY = useRef<number | null>(null);
  const movedRef = useRef(false);
  const [dragY, setDragY] = useState(0);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!open) return;
    startY.current = e.clientY;
    movedRef.current = false;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startY.current == null) return;
    const dy = Math.max(0, e.clientY - startY.current);
    if (dy > 4) movedRef.current = true;
    setDragY(dy);
  };
  const onPointerUp = () => {
    if (startY.current == null) return;
    // Tap (no real motion) → close. Drag past threshold → close. Otherwise stay.
    if (!movedRef.current || dragY > 120) setOpen(false);
    startY.current = null;
    setDragY(0);
  };

  const ciIcon =
    pr.ciState === "success" ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-label="CI green" /> :
    pr.ciState === "failure" || pr.ciState === "error" ? <XCircle className="h-3.5 w-3.5 text-destructive" aria-label="CI red" /> :
    pr.ciState === "pending" ? <Clock className="h-3.5 w-3.5 text-[hsl(45,100%,64%)] animate-pulse" aria-label="CI pending" /> : null;

  const mergeIcon =
    pr.mergeable === "clean" ? <GitMerge className="h-3.5 w-3.5 text-primary" aria-label="No merge conflicts" /> :
    pr.mergeable === "conflicting" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="Merge conflicts" /> :
    pr.mergeable === "checking" ? <Clock className="h-3.5 w-3.5 text-white/40 animate-pulse" aria-label="Mergeable: checking" /> : null;

  return (
    <>
      {/* Scrim — only visible when expanded. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed inset-0 z-30 bg-black/60 backdrop-blur-sm transition-opacity duration-300",
          open ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        onClick={() => setOpen(false)}
      />

      {/* Peek pill (only when collapsed). The peek is now TWO interactive
          surfaces side-by-side: a tap-to-expand region on the left (the
          original behaviour), and — when the PR is mergeable — a small
          green Merge button on the right that opens the drawer pre-armed
          with the confirm card. The button is rendered as a sibling so
          its click doesn't bubble to the expand handler. */}
      {!open && (
        <div className="fade-up fixed inset-x-3 bottom-3 z-40 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/70 px-3 py-3 text-left shadow-2xl backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3"
            aria-label="Open PR drawer"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold leading-tight text-white">{pr.title}</div>
              <div className="mt-1 flex items-center gap-2.5 text-[11px] text-white/70">
                <span className="font-mono">#{pr.number}</span>
                <span>·</span>
                <span>@{pr.author.login}</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1 text-primary"><Plus className="h-3 w-3" />{pr.additions}</span>
                <span className="inline-flex items-center gap-1 text-destructive"><Minus className="h-3 w-3" />{pr.deletions}</span>
                {ciIcon}
                {mergeIcon}
              </div>
              {checklist && checklist.length > 0 && (
                <div className="mt-1.5">
                  <AIChecksBadge items={checklist} />
                </div>
              )}
            </div>
            <GripHorizontal className="h-5 w-5 text-white/60" />
          </button>
          {mergeResult?.kind === "ok" ? (
            <span className="inline-flex h-9 items-center gap-1 rounded-md bg-primary/20 px-2.5 text-[11px] font-medium text-primary">
              <CheckCircle2 className="h-3.5 w-3.5" /> Merged
            </span>
          ) : mergeEligible ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(true);
                setMergeConfirming(true);
              }}
              className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground shadow active:scale-95"
              aria-label="Merge this PR"
            >
              <GitMerge className="h-3.5 w-3.5" />
              Merge
            </button>
          ) : null}
        </div>
      )}

      {/* Expanded sheet. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        style={{ transform: `translateY(${open ? dragY : 100}%)` }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex h-[88dvh] flex-col rounded-t-3xl border-t border-white/10 bg-background shadow-2xl",
          "transition-transform duration-300 ease-out will-change-transform",
          !open && "pointer-events-none",
        )}
      >
        {/* Grabber + close: full-width tap target at the top. Tap or drag
            down to dismiss. The X button on the right is an explicit
            second affordance for users who don't realise the grabber is
            interactive. */}
        <div className="relative flex shrink-0 items-center">
          <div
            className="flex flex-1 cursor-grab items-center justify-center py-4 touch-none active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="h-1.5 w-12 rounded-full bg-muted-foreground/40" />
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close drawer"
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* `overflow-x-hidden` belts-and-braces against any child that
             tries to spill horizontally (the decision form's button row
             was the offender). Padding tightened from px-5 → px-4 to give
             ~8 extra pixels per side back to the form. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10">
          <DrawerMergePanel
            pr={pr}
            mergeEligible={mergeEligible}
            mergeBlockedReason={mergeBlockedReason}
            mergeConfirming={mergeConfirming}
            mergeResult={mergeResult}
            merging={merging}
            onConfirm={onConfirmMerge}
            onOpenConfirm={() => { setMergeResult(null); setMergeConfirming(true); }}
            onCancelConfirm={() => setMergeConfirming(false)}
          />
          {children}
        </div>
      </div>
    </>
  );
}

/** Merge UI rendered at the top of the expanded drawer content.
 *
 * Three states:
 *   - eligible + idle: a primary "Merge PR" button. Tap → confirm card.
 *   - confirm card open: re-states the four "is this safe" signals
 *     (AI / CI / reviews / mergeable) and asks for a deliberate confirm.
 *     This is the friction point — the user has just watched the video,
 *     the button is right there, but a one-tap merge from a glance is
 *     too easy. The confirm dialog forces a re-read.
 *   - merged / error: terminal states. Shown until the next render swap.
 *
 * The four signals here mirror the empty-state triage's ConfirmRow so a
 * reviewer who's seen one already recognises the shape.
 */
function DrawerMergePanel({
  pr,
  mergeEligible,
  mergeBlockedReason,
  mergeConfirming,
  mergeResult,
  merging,
  onConfirm,
  onOpenConfirm,
  onCancelConfirm,
}: {
  pr: OpenPR;
  mergeEligible: boolean;
  mergeBlockedReason: string | null;
  mergeConfirming: boolean;
  mergeResult: { kind: "ok"; sha?: string } | { kind: "err"; message: string } | null;
  merging: boolean;
  onConfirm: () => void;
  onOpenConfirm: () => void;
  onCancelConfirm: () => void;
}) {
  const aiStatus = aiReviewStatus(pr);
  const reviewsBlocking = pr.reviews.changesRequested;
  const reviewsApproved = pr.reviews.approvals;

  if (mergeResult?.kind === "ok") {
    return (
      <div className="mb-4 rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-primary">
          <CheckCircle2 className="h-4 w-4" /> Merged PR #{pr.number}
        </div>
        {mergeResult.sha && (
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{mergeResult.sha.slice(0, 12)}</div>
        )}
      </div>
    );
  }

  if (mergeConfirming) {
    return (
      <div className="mb-4 rounded-xl border border-border bg-background p-3">
        <div className="flex items-start gap-2 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(45,100%,64%)]" />
          <div className="flex-1">
            <div className="font-medium">Merge PR #{pr.number}?</div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              <div className="line-clamp-2 italic">{pr.title}</div>
              <div className="mt-1.5">
                AI review: <strong>{describeAI(aiStatus)}</strong>
                <br />
                CI: <strong>{pr.ciState === "success" ? "green" : pr.ciState === "failure" || pr.ciState === "error" ? "red" : pr.ciState}</strong>
                {" · "}
                Reviews: <strong>
                  {reviewsBlocking > 0 ? `${reviewsBlocking} blocking` : reviewsApproved > 0 ? `${reviewsApproved} approval${reviewsApproved === 1 ? "" : "s"}` : "none"}
                </strong>
                {" · "}
                Mergeable: <strong>{pr.mergeable}</strong>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {mergeResult?.kind === "err" && (
            <span className="mr-auto text-[11px] text-destructive">{mergeResult.message}</span>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onCancelConfirm} disabled={merging}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={merging}>
            {merging ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <GitMerge className="mr-1.5 h-3.5 w-3.5" />}
            Confirm merge
          </Button>
        </div>
      </div>
    );
  }

  // Idle state: render the primary Merge button OR a disabled stub with
  // the reason. We render the disabled variant rather than hiding it so
  // the user can tell at a glance "yes, the button is HERE, it just
  // can't fire right now because conflicts/checks/reviews".
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        {mergeEligible ? (
          <>
            <GitMerge className="h-4 w-4 text-primary" />
            <span>Ready to merge — verified, no conflicts.</span>
          </>
        ) : (
          <>
            <AlertTriangle className="h-4 w-4 text-[hsl(45,100%,64%)]" />
            <span className="line-clamp-2 text-muted-foreground">
              {mergeBlockedReason ?? "Merge unavailable."}
            </span>
          </>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        disabled={!mergeEligible}
        variant={mergeEligible ? "default" : "secondary"}
        onClick={onOpenConfirm}
        title={mergeBlockedReason ?? undefined}
      >
        <GitMerge className="mr-1.5 h-3.5 w-3.5" />
        Merge PR
      </Button>
    </div>
  );
}

/* AI-review status mirrored from empty-state-pr-list.tsx so the drawer
 * shows the same signal logic without coupling the two components. If
 * the latest video's stats has any failed checks → ai had failures;
 * otherwise → passed. No videos → no review. */
type AIStatus = "passed" | "failed" | "none";
function aiReviewStatus(pr: OpenPR): AIStatus {
  if (pr.videos.length === 0) return "none";
  const latest = pr.videos[0];
  if (latest.stats.failed > 0) return "failed";
  return "passed";
}
function describeAI(s: AIStatus): string {
  return s === "passed" ? "passed" : s === "failed" ? "had failures" : "no review yet";
}
