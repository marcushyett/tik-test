import Link from "next/link";
import { signIn } from "@/auth";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { RepoPicker } from "@/components/repo-picker";
import { listRepos } from "@/lib/github";
import { PlayCircle, Github, Sparkles } from "lucide-react";

export default async function HomePage() {
  const session = await auth();
  if (!session) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="flex max-w-md flex-col items-center text-center">
          <div className="mb-6 flex items-center gap-2 rounded-full border bg-muted/30 px-3 py-1 text-xs uppercase tracking-widest text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" /> tik-test review
          </div>
          <h1 className="mb-3 text-4xl font-bold leading-tight">Review every PR in minutes.</h1>
          <p className="mb-8 text-muted-foreground">
            Sign in with GitHub, pick a repo, and swipe through TikTok-style videos of every open PR.
            Approve, request changes, or drop a pill reaction — all posts a real PR review.
          </p>
          <form action={async () => { "use server"; await signIn("github", { redirectTo: "/" }); }}>
            <Button type="submit" size="lg">
              <Github className="h-5 w-5" /> Sign in with GitHub
            </Button>
          </form>
          <p className="mt-6 text-xs text-muted-foreground">
            We ask for the <code className="rounded bg-muted px-1">repo</code> scope so reviews post as you.
            Nothing is stored server-side — this app has no database.
          </p>
        </div>
      </main>
    );
  }

  const repos = await listRepos();

  return (
    <main className="flex flex-1 flex-col px-6 pb-16 pt-10">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <PlayCircle className="h-6 w-6 text-primary" />
          <div>
            <div className="text-lg font-semibold">tik-test review</div>
            <div className="text-xs text-muted-foreground">Signed in as @{(session as any).login ?? "you"}</div>
          </div>
        </div>
        <Link href={{ pathname: "/api/auth/signout" as any }} className="text-xs text-muted-foreground hover:text-foreground">Sign out</Link>
      </header>

      <h2 className="mb-2 text-2xl font-semibold">Pick a repo</h2>
      <p className="mb-6 text-sm text-muted-foreground">Sorted by most-recently-pushed. Only repos you can read show up.</p>
      <RepoPicker repos={repos} />
    </main>
  );
}
