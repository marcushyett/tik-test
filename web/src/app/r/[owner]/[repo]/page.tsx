import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/auth";
import { listPRsWithVideos } from "@/lib/github";
import { VideoFeed } from "@/components/video-feed";

interface Params { owner: string; repo: string }

// Force per-request rendering. Without this, Next.js doesn't trace the
// `cookies()` dependency through the `"use server"` boundary in
// lib/github.ts, statically pre-renders the page at build time (when no
// session exists, so listPRsWithVideos returns []), and serves that
// empty render forever. The home page accidentally avoids this by calling
// `auth()` inline, which Next.js DOES trace as dynamic.
export const dynamic = "force-dynamic";

export default async function RepoFeedPage({ params }: { params: Promise<Params> }) {
  const { owner, repo } = await params;

  // TEMP DIAGNOSTIC — does auth() resolve the bypass session in THIS Server
  // Component context? If yes but listPRsWithVideos still returns [], the
  // bug is specific to crossing the "use server" boundary in lib/github.ts.
  const sessionHere = await auth();
  console.log(
    `[tiktest-bypass] RepoFeedPage(${owner}/${repo}) auth() → ` +
      `present=${!!sessionHere} bypass=${(sessionHere as { bypass?: boolean } | null)?.bypass} ` +
      `login=${(sessionHere as { login?: string } | null)?.login} ` +
      `tokenPresent=${!!(sessionHere as { accessToken?: string } | null)?.accessToken}`,
  );

  const prs = await listPRsWithVideos(owner, repo);

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
        <div className="text-xs text-white/85 md:text-muted-foreground">
          <span className="font-semibold text-white md:text-foreground">{owner}/{repo}</span> · {prs.length} PR{prs.length === 1 ? "" : "s"}
        </div>
      </header>
      <VideoFeed repo={{ owner, name: repo }} prs={prs} />
    </main>
  );
}
