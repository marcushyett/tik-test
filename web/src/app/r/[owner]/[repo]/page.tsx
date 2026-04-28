import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listPRsWithVideos } from "@/lib/github";
import { VideoFeed } from "@/components/video-feed";
import { RepoFeedSkeleton } from "@/components/repo-feed-skeleton";

interface Params { owner: string; repo: string }

// Without this, Next.js can statically pre-render the page at build time
// (when no session exists, so listPRsWithVideos returns []) and serve that
// empty render forever. The home page is naturally dynamic because it
// calls `auth()` inline.
export const dynamic = "force-dynamic";

export default async function RepoFeedPage({ params }: { params: Promise<Params> }) {
  const { owner, repo } = await params;

  return (
    // Mobile: video is full-bleed (h-[100dvh] inside VideoFeed) and the
    // header sits ON TOP of it as a translucent overlay, NOT above it
    // pushing the video down. Desktop keeps the in-flow header.
    <main className="flex flex-1 flex-col md:pb-12 md:pt-6">
      <header
        className="
          fixed inset-x-0 top-0 z-50 flex items-center justify-between
          bg-gradient-to-b from-black/60 via-black/30 to-transparent
          px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]
          backdrop-blur-[2px]
          md:static md:mb-4 md:bg-none md:px-6 md:py-0 md:pt-0 md:backdrop-blur-none
        "
      >
        <Link href="/" className="inline-flex items-center gap-2 text-xs text-white/85 hover:text-white md:text-muted-foreground md:hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All repos
        </Link>
        <RepoTitle owner={owner} repo={repo} />
      </header>

      {/* Stream the actual feed in via Suspense. The shell above (header
          + back link + repo title) renders instantly; the skeleton fills
          the feed area until listPRsWithVideos resolves. Without this,
          the page hangs on a blank screen for several seconds while the
          GitHub API calls run on the server. */}
      <Suspense fallback={<RepoFeedSkeleton />}>
        <RepoFeedContent owner={owner} repo={repo} />
      </Suspense>
    </main>
  );
}

/** Repo title with the live PR count. Stays a small standalone component
 *  so the count can update once the data resolves. The async sibling below
 *  doesn't have to render again to update it; the Suspense boundary holds
 *  this little island stable while the skeleton is up. */
function RepoTitle({ owner, repo }: Params) {
  return (
    <div className="text-xs text-white/85 md:text-muted-foreground">
      <span className="font-semibold text-white md:text-foreground">{owner}/{repo}</span>
    </div>
  );
}

/** The async island that does the slow GitHub round-trips. Anything that
 *  needs the resolved PR list goes inside here so it lands behind the
 *  Suspense boundary above. */
async function RepoFeedContent({ owner, repo }: Params) {
  const prs = await listPRsWithVideos(owner, repo);
  return <VideoFeed repo={{ owner, name: repo }} prs={prs} />;
}
