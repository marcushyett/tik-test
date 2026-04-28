import { Octokit } from "@octokit/rest";
import { auth } from "@/auth";
import { parseMarker, type TikTestVideo } from "./marker";

async function getOctokit(): Promise<Octokit | null> {
  const session = await auth();
  const token = session?.accessToken;
  if (!token) return null;
  return new Octokit({ auth: token });
}

export interface RepoSummary { owner: string; name: string; full_name: string; description: string | null; pushed_at: string; }

export async function listRepos(): Promise<RepoSummary[]> {
  const ok = await getOctokit();
  if (!ok) return [];
  const { data } = await ok.repos.listForAuthenticatedUser({ sort: "pushed", per_page: 50, affiliation: "owner,collaborator,organization_member" });
  return data.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    full_name: r.full_name,
    description: r.description,
    pushed_at: r.pushed_at ?? "",
  }));
}

export interface OpenPR {
  number: number;
  title: string;
  author: { login: string; avatarUrl: string };
  htmlUrl: string;
  body: string;
  createdAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headSha: string;
  reviews: { approvals: number; changesRequested: number; total: number };
  ciState: "pending" | "success" | "failure" | "error" | "unknown";
  /** Normalized merge state. "clean" = no conflicts and the PR can land;
   *  "conflicting" = there are merge conflicts the author needs to resolve;
   *  "checking" = GitHub is still computing mergeability (the first read
   *  after a push routinely returns null and resolves on a follow-up);
   *  "unknown" = anything else GitHub reports (draft PR, blocked by reviews,
   *  branch behind base, CI failing/unstable) — none of those are conflicts
   *  per se, so we lump them under "unknown" for THIS indicator and let
   *  other indicators (CI, reviews) speak for themselves. */
  mergeable: "clean" | "conflicting" | "checking" | "unknown";
  videos: TikTestVideo[];
  comments: Array<{ id: number; author: string; body: string; createdAt: string }>;
}

/**
 * Two-stage parallel pipeline so the page doesn't sit on 30 sequential
 * batches of 4 GitHub round-trips.
 *
 * Stage 1 (broad): pulls.list, then issues.listComments for every open PR
 * in parallel. We only NEED comment data to find the tik-test video
 * marker; everything else (diff stats, review counts, CI status) is
 * decoration that gets thrown away if no video is present.
 *
 * Stage 2 (narrow): for the small subset of PRs that DO have a valid
 * video marker, fetch pulls.get + listReviews + getCombinedStatusForRef
 * in parallel. For a repo with 30 open PRs and 5 carrying videos, this
 * cuts API calls from ~120 sequential to ~50 in two parallel waves —
 * roughly 1s of wall-clock instead of 15s.
 *
 * Octokit's built-in throttling handles per-second bursts; the 30-PR
 * page cap means total calls stay well under any GitHub quota.
 */
export async function listPRsWithVideos(owner: string, repo: string): Promise<OpenPR[]> {
  const ok = await getOctokit();
  if (!ok) return [];

  const prs = await ok.pulls.list({ owner, repo, state: "open", per_page: 30, sort: "updated", direction: "desc" });

  // Stage 1: scan comments for ALL open PRs in parallel. Comments are the
  // only load-bearing per-PR fetch (the marker lives there).
  const stage1 = await Promise.all(prs.data.map(async (p) => {
    const issueComments = await ok.issues.listComments({ owner, repo, issue_number: p.number, per_page: 100 });
    const videos = issueComments.data
      .map((c) => parseMarker(c.body ?? ""))
      .filter((x): x is TikTestVideo => !!x)
      // Newest first.
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return { p, issueComments, videos };
  }));

  // We no longer skip PRs without videos — the empty-state triage dashboard
  // (#23) wants every open PR including the video-less ones so the user can
  // merge a PR that landed CI green even if it was too small for tik-test
  // to produce a review video. The perf gain from PR #18 still applies via
  // the parallelism: Stage 1 + Stage 2 each fan out across all PRs, so the
  // wall-clock cost stays roughly constant in the count of PRs instead of
  // linear.

  // Stage 2: detail / reviews / status for ALL stage-1 PRs, in parallel.
  // Each PR fans out its 3 sub-calls in its own Promise.all; the outer
  // Promise.all runs all PRs concurrently.
  const stage2 = await Promise.all(stage1.map(async (s1) => {
    const [detail, reviews, status] = await Promise.all([
      ok.pulls.get({ owner, repo, pull_number: s1.p.number }),
      ok.pulls.listReviews({ owner, repo, pull_number: s1.p.number, per_page: 100 }),
      ok.repos.getCombinedStatusForRef({ owner, repo, ref: s1.p.head.sha }).catch(() => null),
    ]);
    return { ...s1, detail, reviews, status };
  }));

  return stage2.map(({ p, issueComments, videos, detail, reviews, status }) => {
    const approvals = reviews.data.filter((r) => r.state === "APPROVED").length;
    const changesRequested = reviews.data.filter((r) => r.state === "CHANGES_REQUESTED").length;
    let ciState: OpenPR["ciState"] = "unknown";
    if (status?.data.state) {
      const s = status.data.state.toLowerCase();
      if (s === "success" || s === "failure" || s === "error" || s === "pending") ciState = s as OpenPR["ciState"];
    }

    // Normalize mergeable state. detail.data.mergeable is null while GitHub
    // is still computing it — that's normal right after a push. mergeable_state
    // is more granular ("clean" / "dirty" / "blocked" / "behind" / "draft" /
    // "unstable" / "unknown"). We map both into one display state focused on
    // the conflicts question.
    const mergeableRaw = detail.data.mergeable; // boolean | null | undefined
    const mergeStateRaw = (detail.data as any).mergeable_state as string | undefined;
    let mergeable: OpenPR["mergeable"] = "unknown";
    if (mergeStateRaw === "dirty" || mergeableRaw === false) mergeable = "conflicting";
    else if (mergeStateRaw === "clean") mergeable = "clean";
    else if (mergeableRaw === null || mergeableRaw === undefined) mergeable = "checking";

    return {
      number: p.number,
      title: p.title,
      author: { login: p.user?.login ?? "", avatarUrl: p.user?.avatar_url ?? "" },
      htmlUrl: p.html_url,
      body: (p.body ?? "").slice(0, 4000),
      createdAt: p.created_at,
      additions: detail.data.additions,
      deletions: detail.data.deletions,
      changedFiles: detail.data.changed_files,
      headSha: p.head.sha,
      reviews: { approvals, changesRequested, total: reviews.data.length },
      ciState,
      mergeable,
      videos,
      comments: issueComments.data
        .filter((c) => !/<!--\s*tik-test-video:v/.test(c.body ?? "")) // hide our own meta-comments
        .slice(-10)
        .map((c) => ({
          id: c.id,
          author: c.user?.login ?? "",
          body: (c.body ?? "").slice(0, 1200),
          createdAt: c.created_at,
        })),
    };
  });
}

/** Merge a PR on the user's behalf. Refuses on bypass sessions for the same
 *  reason submitReview does — even if the bypass PAT had write scope, the
 *  bypass session is meant for read-only test access, never destructive
 *  actions. The optional `expectedHeadSha` is passed straight through to
 *  GitHub so we get a 409 if a new commit landed between the user opening
 *  the dialog and clicking Merge (it's the standard "concurrent edit"
 *  guard for the GitHub merge endpoint). */
export async function submitMerge(input: {
  owner: string;
  repo: string;
  number: number;
  expectedHeadSha?: string;
  /** Defaults to "merge" (i.e. a merge commit). Could be plumbed up from the
   *  UI later for squash/rebase variants. */
  method?: "merge" | "squash" | "rebase";
}): Promise<{ ok: true; sha?: string } | { ok: false; error: string }> {
  const session = await auth();
  if (session?.bypass === true) {
    return { ok: false, error: "Merging PRs isn't allowed from a test-bypass session." };
  }
  const token = session?.accessToken;
  if (!token) return { ok: false, error: "Not signed in." };
  const ok = new Octokit({ auth: token });
  try {
    const { data } = await ok.pulls.merge({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.number,
      sha: input.expectedHeadSha,
      merge_method: input.method ?? "merge",
    });
    return { ok: true, sha: data.sha };
  } catch (e: any) {
    // Common failure modes worth surfacing verbatim: 405 not_mergeable,
    // 409 sha mismatch, 422 conflicting state. The .message GitHub returns
    // is already human-readable.
    return { ok: false, error: (e as Error).message };
  }
}

/** Post a formal PR review on the user's behalf. Refuses to run when the
 *  caller is on a test-bypass session — even if the bypass PAT had write
 *  scope (it shouldn't), this would block any abuse of the bypass to
 *  post reviews. */
export async function submitReview(input: {
  owner: string;
  repo: string;
  number: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (session?.bypass === true) {
    return { ok: false, error: "Reviews can't be posted from a test-bypass session." };
  }
  const token = session?.accessToken;
  if (!token) return { ok: false, error: "Not signed in." };
  const ok = new Octokit({ auth: token });
  try {
    await ok.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.number,
      event: input.event,
      body: input.body,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
