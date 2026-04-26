"use client";

import { Bot, Check, Minus, MinusCircle, X } from "lucide-react";
import type { ChecklistItem } from "@/lib/marker";

/**
 * Native render of the LLM-synthesised "AI checks" list — same data the
 * video's outro shows on the final frame, surfaced inline so reviewers
 * don't have to play the MP4 to scan it.
 */
export function AIChecksList({ items }: { items: ChecklistItem[] }) {
  if (items.length === 0) return null;
  const passed = items.filter((i) => i.outcome === "success").length;
  const failed = items.filter((i) => i.outcome === "failure").length;
  const skipped = items.filter((i) => i.outcome === "skipped").length;

  return (
    <div className="rounded-2xl border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
            AI checks
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
          {failed > 0 && (
            <span className="inline-flex items-center gap-1 text-destructive">
              <X className="h-3 w-3" strokeWidth={2.5} />
              {failed}
            </span>
          )}
          {passed > 0 && (
            <span className="inline-flex items-center gap-1 text-primary">
              <Check className="h-3 w-3" strokeWidth={2.5} />
              {passed}
            </span>
          )}
          {skipped > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <MinusCircle className="h-3 w-3" strokeWidth={2} />
              {skipped}
            </span>
          )}
        </div>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li
            key={i}
            className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 ${
              it.outcome === "failure"
                ? "border-destructive/30 bg-destructive/5"
                : "border-border/60 bg-background/40"
            }`}
          >
            <Glyph outcome={it.outcome} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium leading-snug text-foreground">{it.label}</div>
              {it.note && (
                <div
                  className={`mt-0.5 text-[11px] leading-snug ${
                    it.outcome === "failure" ? "text-destructive/90" : "text-muted-foreground"
                  }`}
                >
                  {it.note}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Glyph({ outcome }: { outcome: ChecklistItem["outcome"] }) {
  // Outline glyphs in the tone colour — no filled circle. Filled circles
  // with a white check/X read as ✅/❌ emoji at a glance, which clashes
  // with the rest of the app's understated lucide-icon vocabulary.
  const base = "mt-0.5 h-4 w-4 shrink-0";
  if (outcome === "failure") return <X className={`${base} text-destructive`} strokeWidth={2.4} />;
  if (outcome === "skipped") return <Minus className={`${base} text-muted-foreground`} strokeWidth={2.2} />;
  return <Check className={`${base} text-primary`} strokeWidth={2.4} />;
}

/** Compact pass/fail pill for the collapsed mobile drawer peek. */
export function AIChecksBadge({ items }: { items: ChecklistItem[] }) {
  if (items.length === 0) return null;
  const passed = items.filter((i) => i.outcome === "success").length;
  const failed = items.filter((i) => i.outcome === "failure").length;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2 py-0.5 font-mono text-[10px] text-white/85"
      title={`tik-test AI checks: ${passed} passed · ${failed} failed`}
    >
      <Bot className="h-3 w-3 shrink-0" />
      {failed > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[hsl(0,80%,75%)]">
          <X className="h-2.5 w-2.5" strokeWidth={2.5} />
          {failed}
        </span>
      )}
      <span className="inline-flex items-center gap-0.5">
        <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
        {passed}
      </span>
    </span>
  );
}
