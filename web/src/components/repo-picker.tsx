"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import type { RepoSummary } from "@/lib/github";
import { formatRelativeTime } from "@/lib/utils";

export function RepoPicker({ repos }: { repos: RepoSummary[] }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return repos;
    const t = q.toLowerCase();
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(t) ||
        (r.description?.toLowerCase().includes(t) ?? false),
    );
  }, [repos, q]);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search repos…"
          className="h-11 w-full rounded-xl border border-border bg-muted/30 pl-10 pr-3 text-sm placeholder:text-muted-foreground/70 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <kbd className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
          /
        </kbd>
      </div>

      <ul className="flex flex-col gap-1.5">
        {filtered.map((r) => (
          <li key={r.full_name} className="fade-up">
            <Link
              href={{ pathname: `/r/${r.owner}/${r.name}` as any }}
              className="group flex items-center justify-between rounded-xl border border-border bg-card/50 px-4 py-3.5 transition-all hover:border-primary/40 hover:bg-card hover:-translate-y-px hover:shadow-lift"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium tracking-tight">{r.owner}/</span>
                  <span className="truncate text-[15px] font-semibold tracking-tight">{r.name}</span>
                </div>
                {r.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{r.description}</div>
                )}
              </div>
              <div className="shrink-0 pl-4 text-right">
                {r.pushed_at && (
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {formatRelativeTime(r.pushed_at)}
                  </div>
                )}
                <ArrowUpRight className="ml-auto mt-1 h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
              </div>
            </Link>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="rounded-xl border border-dashed border-border bg-muted/10 p-8 text-center text-sm text-muted-foreground">
            Nothing matched "{q}". Try a different query or{" "}
            <button type="button" onClick={() => setQ("")} className="text-primary hover:underline">
              clear the filter
            </button>.
          </li>
        )}
      </ul>
    </div>
  );
}
