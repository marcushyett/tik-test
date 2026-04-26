"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, GripHorizontal, Minus, Plus, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { AIChecksBadge } from "./ai-checks-list";
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
    pr.ciState === "success" ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> :
    pr.ciState === "failure" || pr.ciState === "error" ? <XCircle className="h-3.5 w-3.5 text-destructive" /> :
    pr.ciState === "pending" ? <Clock className="h-3.5 w-3.5 text-[hsl(45,100%,64%)] animate-pulse" /> : null;

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

      {/* Peek pill (only when collapsed). */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fade-up fixed inset-x-3 bottom-3 z-40 flex items-center gap-3 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 text-left shadow-2xl backdrop-blur-xl"
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
            </div>
            {checklist && checklist.length > 0 && (
              <div className="mt-1.5">
                <AIChecksBadge items={checklist} />
              </div>
            )}
          </div>
          <GripHorizontal className="h-5 w-5 text-white/60" />
        </button>
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
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10">{children}</div>
      </div>
    </>
  );
}
