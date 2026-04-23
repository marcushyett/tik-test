"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { RepoSummary } from "@/lib/github";
import { formatRelativeTime } from "@/lib/utils";

export function RepoPicker({ repos }: { repos: RepoSummary[] }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return repos;
    const t = q.toLowerCase();
    return repos.filter((r) => r.full_name.toLowerCase().includes(t) || r.description?.toLowerCase().includes(t));
  }, [repos, q]);

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter your repos…"
          className="w-full rounded-xl border bg-muted/30 py-3 pl-10 pr-3 text-sm focus:border-primary focus:outline-none"
        />
      </div>
      <ul className="mt-5 flex flex-col gap-2">
        {filtered.map((r) => (
          <li key={r.full_name}>
            <Link
              href={{ pathname: `/r/${r.owner}/${r.name}` as any }}
              className="flex items-center justify-between rounded-xl border bg-card/40 px-4 py-3 transition-colors hover:border-primary/60 hover:bg-card"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{r.full_name}</div>
                {r.description && <div className="truncate text-xs text-muted-foreground">{r.description}</div>}
              </div>
              <div className="shrink-0 pl-3 text-right text-xs text-muted-foreground">
                {r.pushed_at ? formatRelativeTime(r.pushed_at) : ""}
              </div>
            </Link>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="rounded-xl border border-dashed bg-muted/10 p-6 text-center text-sm text-muted-foreground">
            No repos matched.
          </li>
        )}
      </ul>
    </div>
  );
}
