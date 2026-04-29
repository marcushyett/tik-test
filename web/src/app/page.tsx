import Link from "next/link";
import { signIn, auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { RepoPicker } from "@/components/repo-picker";
import { listRepos } from "@/lib/github";
import Script from "next/script";
import { ArrowRight, Github, PlayCircle, Sparkles } from "lucide-react";

const REPO_URL = "https://github.com/marcushyett/tik-test";
const REPO_SLUG = "marcushyett/tik-test";

// Official GitHub Buttons snippet from https://buttons.github.io/.
// The <a class="github-button"> is progressively enhanced into an iframe by
// buttons.js (loaded once in <Landing>). Color scheme is forced dark to match.
function GitHubStarButton({ size = "large" }: { size?: "large" | "small" }) {
  return (
    <a
      className="github-button"
      href={REPO_URL}
      data-color-scheme="no-preference: dark; light: dark; dark: dark;"
      data-icon="octicon-star"
      data-size={size === "large" ? "large" : undefined}
      data-show-count="true"
      aria-label={`Star ${REPO_SLUG} on GitHub`}
    >
      Star
    </a>
  );
}

export default async function HomePage() {
  const session = await auth();
  if (!session) return <Landing />;
  const repos = await listRepos();
  return <SignedIn login={(session as any).login} repos={repos} />;
}

function Landing() {
  return (
    <main className="relative flex min-h-screen flex-col">
      {/* Ambient hero glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute left-1/2 top-[-10%] h-[540px] w-[540px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute right-[-10%] bottom-[-10%] h-[420px] w-[420px] rounded-full bg-accent/10 blur-3xl" />
      </div>

      <header className="flex items-center justify-between px-6 py-6 sm:px-8">
        <div className="flex items-center gap-2">
          <PlayCircle className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight">tik-test review</span>
          <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            beta
          </span>
        </div>
        <GitHubStarButton size="large" />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <div className="mx-auto flex max-w-xl flex-col items-center text-center">
          <div className="fade-up mb-6 inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            PR reviews, as a swipe
          </div>

          <h1 className="fade-up [animation-delay:60ms] bg-gradient-to-b from-foreground to-foreground/70 bg-clip-text text-5xl font-semibold leading-[0.98] tracking-[-0.04em] text-transparent sm:text-6xl">
            Watch every open PR.
            <br />
            <span className="bg-gradient-to-br from-primary to-accent bg-clip-text text-transparent">Ship ten of them.</span>
          </h1>

          <p className="fade-up [animation-delay:120ms] mt-6 max-w-md text-balance text-base leading-relaxed text-muted-foreground">
            Pick a repo. Swipe through the 45-second narrated videos that the open-source <Link href={REPO_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline decoration-primary/40 underline-offset-4 hover:decoration-primary">tik-test</Link> agent records on every open PR. Tap a pill, drop a note, approve or request changes — the app posts a real GitHub review on your behalf. Zero backend; your token lives in a session cookie and nowhere else.
          </p>

          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/" });
            }}
            className="fade-up [animation-delay:200ms] mt-10"
          >
            <Button type="submit" size="lg" className="h-12 px-6 text-[15px]">
              <Github className="h-5 w-5" />
              Sign in with GitHub
              <ArrowRight className="h-4 w-4 opacity-70" />
            </Button>
          </form>
          <p className="fade-up [animation-delay:260ms] mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/80">
            requests the <span className="text-foreground">repo</span> scope · posts reviews as you
          </p>
        </div>

        {/* Feature strip — understated, monospaced micro-type. */}
        <div className="fade-up [animation-delay:320ms] mt-16 grid w-full max-w-3xl grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCell title="TikTok-native nav" body="↑/↓/j/k, space, esc. Autoplay then decide." />
          <FeatureCell title="GitHub-native review" body="Approve / Request Changes via real Reviews API." />
          <FeatureCell title="No database" body="Just GitHub + your access token. Nothing stored." />
          <FeatureCell title="Open source" body="MIT-licensed. Self-host, fork, or send a PR." />
        </div>
      </section>

      <footer className="border-t border-border/60 px-6 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-4 text-xs text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-3">
            <PlayCircle className="h-4 w-4 text-primary" />
            <span className="font-mono uppercase tracking-[0.14em]">
              tik-test · open source · MIT
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <Github className="h-3.5 w-3.5" />
              marcushyett/tik-test
            </Link>
            <Link
              href={`${REPO_URL}/blob/main/LICENSE`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground"
            >
              License
            </Link>
            <Link
              href={`${REPO_URL}#readme`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground"
            >
              Docs
            </Link>
          </div>
        </div>
      </footer>
      <Script src="https://buttons.github.io/buttons.js" strategy="afterInteractive" />
    </main>
  );
}

function FeatureCell({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1 bg-card/70 p-5">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{title}</span>
      <span className="text-sm text-foreground/80">{body}</span>
    </div>
  );
}

function SignedIn({ login, repos }: { login?: string; repos: any[] }) {
  return (
    <main className="flex flex-1 flex-col px-6 pb-16 pt-10">
      <header className="mx-auto mb-10 flex w-full max-w-xl items-center justify-between">
        <div className="flex items-center gap-3">
          <PlayCircle className="h-6 w-6 text-primary" />
          <div>
            <div className="text-sm font-semibold tracking-tight">tik-test review</div>
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              signed in as @{login ?? "you"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <GitHubStarButton size="small" />
          <Link href={{ pathname: "/api/auth/signout" as any }} className="text-xs text-muted-foreground hover:text-foreground">
            sign out
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-xl">
        <h2 className="text-2xl font-semibold tracking-tight">Pick a repo</h2>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Sorted by most-recently-pushed. Only repos you can read show up.
        </p>
        <RepoPicker repos={repos} />
      </div>
      <Script src="https://buttons.github.io/buttons.js" strategy="afterInteractive" />
    </main>
  );
}
