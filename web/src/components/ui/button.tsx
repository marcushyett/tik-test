import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Button surfaces for the review feed. Keep them disciplined:
 * - `default`/primary is an action (Post review). Solid fill, bold weight.
 * - `secondary`/`outline` carry metadata actions (skip, back).
 * - `ghost` for navigation; `icon` for tiny controls on the video surface.
 * - `accent` for the TikTok-y electric-purple comment/non-verdict path.
 * - `destructive` for Request Changes — never a delete-of-real-data.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium",
    "transition-[transform,background-color,color,box-shadow,opacity] duration-150",
    "active:translate-y-px active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:brightness-110 shadow-[0_8px_24px_-8px_hsl(148_84%_52%_/_0.6)]",
        secondary:
          "bg-muted text-foreground hover:bg-muted/70 border border-border",
        ghost:
          "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
        outline:
          "border border-border bg-transparent hover:bg-muted/60",
        destructive:
          "bg-destructive text-destructive-foreground hover:brightness-110 shadow-[0_8px_24px_-8px_hsl(0_82%_64%_/_0.55)]",
        accent:
          "bg-accent text-accent-foreground hover:brightness-110 shadow-[0_8px_24px_-8px_hsl(260_90%_70%_/_0.55)]",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
        iconLg: "h-12 w-12",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";
export { buttonVariants };
