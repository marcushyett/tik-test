import { cn } from "@/lib/utils";

export function StatRow({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "green" | "red" | "amber" | "muted" }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span className={cn(
        "font-semibold tabular-nums",
        accent === "green" && "text-primary",
        accent === "red" && "text-destructive",
        accent === "amber" && "text-[hsl(45,100%,64%)]",
      )}>{value}</span>
      <span>{label}</span>
    </span>
  );
}
