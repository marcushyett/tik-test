import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listPRsWithVideos } from "@/lib/github";
import { VideoFeed } from "@/components/video-feed";

interface Params { owner: string; repo: string }

export default async function RepoFeedPage({ params }: { params: Promise<Params> }) {
  const { owner, repo } = await params;
  const prs = await listPRsWithVideos(owner, repo);

  return (
    <main className="flex flex-1 flex-col pb-12 pt-6">
      <header className="mb-4 flex items-center justify-between px-6">
        <Link href="/" className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All repos
        </Link>
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{owner}/{repo}</span> · {prs.length} PR{prs.length === 1 ? "" : "s"} to review
        </div>
      </header>
      <VideoFeed repo={{ owner, name: repo }} prs={prs} />
    </main>
  );
}
