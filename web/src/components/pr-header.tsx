import { AlertTriangle, CheckCircle2, Clock, ExternalLink, FileText, GitMerge, GitPullRequest, Minus, Plus, XCircle } from "lucide-react";
import type { OpenPR } from "@/lib/github";

/**
 * Compact PR header that carries the essentials a reviewer needs to decide
 * *before* the video plays:  PR title, who authored it, how big it is,
 * whether CI is green, how many prior reviews exist.
 *
 * Visual vocabulary kept tight to feel GitHub-native: monospace for numbers,
 * muted dot separators, coloured leading icons for the +/- / CI pills.
 */
export function PRHeader({ repo, pr }: { repo: { owner: string; name: string }; pr: OpenPR }) {
  const ciBadge = renderCI(pr.ciState);
  const mergeBadge = renderMergeable(pr.mergeable);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <GitPullRequest className="h-3.5 w-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <a
            href={pr.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-baseline gap-1.5 text-[17px] font-semibold leading-tight tracking-tight text-foreground hover:text-primary"
          >
            <span className="line-clamp-2">{pr.title}</span>
            <ExternalLink className="relative top-1 h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-80" />
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="font-mono">{repo.owner}/{repo.name}</span> · #{pr.number}
            </span>
            <span>·</span>
            <span>by <span className="text-foreground/80">@{pr.author.login}</span></span>
          </div>
        </div>
      </div>

      {/* Metric row — tiny, monospace, colour-coded. */}
      <div className="flex flex-wrap items-center gap-2">
        <Metric icon={<Plus className="h-3 w-3" />} value={pr.additions.toLocaleString()} tone="positive" />
        <Metric icon={<Minus className="h-3 w-3" />} value={pr.deletions.toLocaleString()} tone="negative" />
        <Metric icon={<FileText className="h-3 w-3" />} value={`${pr.changedFiles} files`} tone="muted" />
        {pr.reviews.approvals > 0 && (
          <Metric icon={<CheckCircle2 className="h-3 w-3" />} value={`${pr.reviews.approvals} approved`} tone="positive" />
        )}
        {pr.reviews.changesRequested > 0 && (
          <Metric icon={<XCircle className="h-3 w-3" />} value={`${pr.reviews.changesRequested} blocking`} tone="negative" />
        )}
        {ciBadge}
        {mergeBadge}
      </div>
    </div>
  );
}

type Tone = "positive" | "negative" | "muted" | "warn";

function Metric({ icon, value, tone }: { icon: React.ReactNode; value: string; tone: Tone }) {
  const toneClass =
    tone === "positive"
      ? "text-primary bg-primary/10 border-primary/20"
      : tone === "negative"
      ? "text-destructive bg-destructive/10 border-destructive/20"
      : tone === "warn"
      ? "text-[hsl(45,100%,64%)] bg-[hsl(45,100%,64%)_/_0.1] border-[hsl(45,100%,64%)_/_0.2]"
      : "text-muted-foreground bg-muted/40 border-border";
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-[10.5px] ${toneClass}`}>
      {icon}
      {value}
    </span>
  );
}

function renderCI(state: OpenPR["ciState"]) {
  if (state === "success") {
    return <Metric icon={<CheckCircle2 className="h-3 w-3" />} value="ci green" tone="positive" />;
  }
  if (state === "failure" || state === "error") {
    return <Metric icon={<XCircle className="h-3 w-3" />} value="ci red" tone="negative" />;
  }
  if (state === "pending") {
    return <Metric icon={<Clock className="h-3 w-3 animate-pulse" />} value="ci pending" tone="warn" />;
  }
  return null;
}

function renderMergeable(state: OpenPR["mergeable"]) {
  if (state === "clean") {
    return <Metric icon={<GitMerge className="h-3 w-3" />} value="no conflicts" tone="positive" />;
  }
  if (state === "conflicting") {
    return <Metric icon={<AlertTriangle className="h-3 w-3" />} value="conflicts" tone="negative" />;
  }
  if (state === "checking") {
    return <Metric icon={<Clock className="h-3 w-3 animate-pulse" />} value="merge: checking" tone="muted" />;
  }
  return null;
}
