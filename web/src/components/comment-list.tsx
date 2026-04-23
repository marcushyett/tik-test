import { formatRelativeTime } from "@/lib/utils";
import { Markdown } from "./ui/markdown";
import type { OpenPR } from "@/lib/github";

export function CommentList({ comments }: { comments: OpenPR["comments"] }) {
  if (!comments.length) {
    return <div className="rounded-xl border border-dashed border-border bg-muted/10 p-4 text-xs text-muted-foreground">No reviewer comments yet — be the first.</div>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {comments.slice(-8).map((c) => (
        <li key={c.id} className="rounded-xl border border-border bg-muted/20 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="font-semibold">@{c.author}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{formatRelativeTime(c.createdAt)}</span>
          </div>
          <Markdown>{c.body}</Markdown>
        </li>
      ))}
    </ul>
  );
}
