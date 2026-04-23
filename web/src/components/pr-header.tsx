import { ExternalLink, GitPullRequest, CheckCircle2, XCircle, Clock } from "lucide-react";
import { StatRow } from "./ui/stat-row";
import type { OpenPR } from "@/lib/github";

export function PRHeader({ repo, pr }: { repo: { owner: string; name: string }; pr: OpenPR }) {
  const ciIcon = pr.ciState === "success" ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> :
                 pr.ciState === "failure" || pr.ciState === "error" ? <XCircle className="h-3.5 w-3.5 text-destructive" /> :
                 pr.ciState === "pending" ? <Clock className="h-3.5 w-3.5 text-[hsl(45,100%,64%)] animate-pulse" /> : null;
  return (
    <div className="flex items-start gap-3">
      <GitPullRequest className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a
            href={pr.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-1 truncate text-base font-semibold leading-tight text-foreground hover:underline"
          >
            <span className="truncate">{pr.title}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-80" aria-hidden />
          </a>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">{repo.owner}/{repo.name} · #{pr.number}</span>
          <span className="text-muted-foreground">by @{pr.author.login}</span>
          <StatRow label="added" value={`+${pr.additions}`} accent="green" />
          <StatRow label="removed" value={`−${pr.deletions}`} accent="red" />
          <StatRow label="files" value={pr.changedFiles} accent="muted" />
          {pr.reviews.approvals > 0 && <StatRow label="approvals" value={pr.reviews.approvals} accent="green" />}
          {pr.reviews.changesRequested > 0 && <StatRow label="changes requested" value={pr.reviews.changesRequested} accent="red" />}
          {ciIcon && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{ciIcon} CI {pr.ciState}</span>}
        </div>
      </div>
    </div>
  );
}
