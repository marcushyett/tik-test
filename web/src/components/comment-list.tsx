import { formatRelativeTime } from "@/lib/utils";
import type { OpenPR } from "@/lib/github";

export function CommentList({ comments }: { comments: OpenPR["comments"] }) {
  if (!comments.length) {
    return <div className="text-xs text-muted-foreground">No reviewer comments yet — be the first.</div>;
  }
  return (
    <ul className="space-y-3">
      {comments.slice(-5).map((c) => (
        <li key={c.id} className="rounded-xl border bg-muted/20 p-3">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-semibold">@{c.author}</span>
            <span className="text-muted-foreground">{formatRelativeTime(c.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">{c.body}</p>
        </li>
      ))}
    </ul>
  );
}
