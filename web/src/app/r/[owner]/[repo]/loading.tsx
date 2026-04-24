import { Loader2 } from "lucide-react";

/**
 * Route-segment loading UI for /r/[owner]/[repo]. Next.js renders this
 * immediately on navigation while the server component (which fetches
 * GitHub PRs + tik-test video markers) resolves. Without it the app
 * appeared to "freeze" on repo click.
 */
export default function Loading() {
  return (
    <main className="flex min-h-[70dvh] flex-1 flex-col items-center justify-center gap-4 px-6 py-12">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" strokeWidth={1.5} />
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-sm font-medium text-foreground">Finding tik-test videos…</div>
        <div className="text-xs text-muted-foreground">Scanning open PRs on GitHub for review comments.</div>
      </div>
    </main>
  );
}
