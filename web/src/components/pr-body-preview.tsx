"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function PRBodyPreview({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  if (!body?.trim()) return null;
  return (
    <div className="rounded-xl border bg-muted/15">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-3 text-left text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        PR description
      </button>
      {open && (
        <div className="border-t p-3 text-sm text-foreground/90">
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6">{body}</pre>
        </div>
      )}
    </div>
  );
}
