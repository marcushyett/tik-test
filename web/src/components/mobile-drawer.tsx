"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, GripHorizontal, Minus, Plus, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OpenPR } from "@/lib/github";

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
  children,
}: {
  pr: OpenPR;
  repo: { owner: string; name: string };
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

  // Drag-to-dismiss: track pointer vertical delta on the grabber.
  const startY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!open) return;
    startY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startY.current == null) return;
    setDragY(Math.max(0, e.clientY - startY.current));
  };
  const onPointerUp = () => {
    if (startY.current == null) return;
    if (dragY > 120) setOpen(false);
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
        {/* Grabber */}
        <div
          className="flex shrink-0 cursor-grab items-center justify-center py-3 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
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
