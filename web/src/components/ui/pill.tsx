import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Reaction pill — think TikTok's quick reactions but typed, not emoji. Dense
 * and tappable, with a deliberate luminous lift when selected.
 */
export interface PillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  tone?: "neutral" | "positive" | "negative" | "warn";
}

const toneTint: Record<NonNullable<PillProps["tone"]>, string> = {
  neutral: "data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground data-[selected=true]:border-primary data-[selected=true]:shadow-[0_6px_18px_-6px_hsl(148_84%_52%_/_0.6)]",
  positive: "data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground data-[selected=true]:border-primary data-[selected=true]:shadow-[0_6px_18px_-6px_hsl(148_84%_52%_/_0.6)]",
  negative: "data-[selected=true]:bg-destructive data-[selected=true]:text-destructive-foreground data-[selected=true]:border-destructive data-[selected=true]:shadow-[0_6px_18px_-6px_hsl(0_82%_64%_/_0.55)]",
  warn: "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:border-accent",
};

export const Pill = React.forwardRef<HTMLButtonElement, PillProps>(
  ({ className, selected, tone = "neutral", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group relative h-9 rounded-full border px-3.5 text-xs font-medium tracking-tight",
        "border-border bg-muted/40 text-foreground/80",
        "transition-all duration-150",
        "hover:bg-muted hover:text-foreground hover:-translate-y-px",
        "active:translate-y-px active:scale-[0.98]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        toneTint[tone],
        className,
      )}
      {...props}
    />
  ),
);
Pill.displayName = "Pill";
