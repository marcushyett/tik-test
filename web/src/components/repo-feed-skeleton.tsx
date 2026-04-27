/**
 * Skeleton shown while listPRsWithVideos resolves on the repo feed page.
 *
 * Why this exists: that fetch makes a `pulls.list` call plus several per-PR
 * round-trips (issues.listComments, pulls.listReviews, etc.) — for a repo
 * with 30 open PRs that's 100+ GitHub API calls. The Suspense fallback gives
 * the user immediate visual feedback that the page is working, instead of
 * leaving them on a blank screen for several seconds.
 *
 * Layout mirrors the real feed at the structural level (counter pill,
 * 9:16 video frame on desktop / full-bleed on mobile, sidebar columns)
 * so the page doesn't visually shift when the real content streams in.
 */

export function RepoFeedSkeleton() {
  return (
    <>
      {/* ========== Desktop two-column skeleton ========== */}
      <div
        aria-busy="true"
        aria-label="Loading pull request feed"
        className="hidden h-[calc(100dvh-80px)] md:grid md:grid-cols-[minmax(0,420px)_minmax(0,1fr)] md:gap-8 md:px-6 md:pb-10"
      >
        <div className="flex min-h-0 flex-col gap-3">
          {/* Counter row */}
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2">
              <span className="block h-3 w-20 animate-pulse rounded bg-muted/60" />
              <span className="block h-4 w-10 animate-pulse rounded-full bg-muted/40" />
            </span>
            <span className="block h-3 w-24 animate-pulse rounded bg-muted/40" />
          </div>
          {/* 9:16 video frame */}
          <div
            className="relative w-full animate-pulse overflow-hidden rounded-lg bg-muted/30"
            style={{ aspectRatio: "9 / 16" }}
          >
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/70">
              loading…
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-4 pr-1 pb-10">
          <div className="h-6 w-3/4 animate-pulse rounded bg-muted/50" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted/40" />
          <div className="space-y-2">
            <div className="h-3 w-full animate-pulse rounded bg-muted/30" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-muted/30" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted/30" />
          </div>
          <div className="mt-2 h-32 animate-pulse rounded bg-muted/20" />
        </div>
      </div>

      {/* ========== Mobile fullscreen skeleton ========== */}
      <div
        aria-busy="true"
        aria-label="Loading pull request feed"
        className="relative h-[100dvh] w-full overflow-hidden bg-black md:hidden"
      >
        <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-zinc-900 via-zinc-950 to-black" />
        <div className="absolute inset-x-0 bottom-24 flex flex-col items-center gap-2 text-xs text-white/60">
          <span className="block h-3 w-32 animate-pulse rounded bg-white/15" />
          <span className="block h-3 w-20 animate-pulse rounded bg-white/10" />
        </div>
      </div>
    </>
  );
}
