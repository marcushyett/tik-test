"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * GitHub-flavoured markdown renderer tuned for the dark glass surfaces.
 * Tables, task lists, autolinks, strikethrough all supported via remark-gfm.
 * Images inside comments often point at private GitHub user-assets — we let
 * the browser try them; they'll silently fail rather than crash the layout.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-invert prose-sm max-w-none",
        "prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-p:my-2 prose-p:leading-relaxed",
        "prose-a:text-primary hover:prose-a:text-primary/80",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal before:prose-code:content-none after:prose-code:content-none",
        "prose-pre:rounded-xl prose-pre:border prose-pre:border-border prose-pre:bg-muted/70 prose-pre:p-4 prose-pre:text-[12px]",
        "prose-blockquote:border-l-2 prose-blockquote:border-primary/50 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground",
        "prose-table:text-[12px] prose-table:border prose-table:border-border prose-th:bg-muted/40 prose-th:border prose-th:border-border prose-th:px-2 prose-th:py-1 prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1",
        "prose-img:rounded-lg prose-img:border prose-img:border-border",
        "prose-li:my-0.5 prose-hr:border-border",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
