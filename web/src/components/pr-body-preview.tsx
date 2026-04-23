"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "./ui/markdown";

export function PRBodyPreview({ body, defaultOpen }: { body: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!body?.trim()) return null;
  return (
    <div className="rounded-xl border bg-muted/15">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-3 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        PR description
      </button>
      {open && (
        <div className="border-t p-4">
          <Markdown>{body}</Markdown>
        </div>
      )}
    </div>
  );
}
