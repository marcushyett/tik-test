import * as React from "react";
import { cn } from "@/lib/utils";

export interface PillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export const Pill = React.forwardRef<HTMLButtonElement, PillProps>(
  ({ className, selected, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
        "border-border bg-muted/40 text-foreground/80 hover:bg-muted",
        "data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground data-[selected=true]:border-primary",
        className,
      )}
      {...props}
    />
  ),
);
Pill.displayName = "Pill";
