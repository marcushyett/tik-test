"use server";

import { Octokit } from "@octokit/rest";
import { auth } from "@/auth";
import { parseMarker, type TikTestVideo } from "./marker";

async function getOctokit(): Promise<Octokit | null> {
  const session = (await auth()) as any;
  const token = session?.accessToken as string | undefined;
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
  videos: TikTestVideo[];
  comments: Array<{ id: number; author: string; body: string; createdAt: string }>;
}

export async function listPRsWithVideos(owner: string, repo: string): Promise<OpenPR[]> {
  const ok = await getOctokit();
  if (!ok) return [];

  // 1. Pull open PRs (top-level metadata).
  const prs = await ok.pulls.list({ owner, repo, state: "open", per_page: 30, sort: "updated", direction: "desc" });

  const out: OpenPR[] = [];
  for (const p of prs.data) {
    // 2. Per-PR detail + comments + reviews + combined status.
    const [detail, issueComments, reviews, status] = await Promise.all([
      ok.pulls.get({ owner, repo, pull_number: p.number }),
      ok.issues.listComments({ owner, repo, issue_number: p.number, per_page: 100 }),
      ok.pulls.listReviews({ owner, repo, pull_number: p.number, per_page: 100 }),
      ok.repos.getCombinedStatusForRef({ owner, repo, ref: p.head.sha }).catch(() => null),
    ]);

    const videos = issueComments.data
      .map((c) => {
        const parsed = parseMarker(c.body ?? "");
        if (!parsed) return null;
        // Authorship rule: only comments authored by the same account that's commenting as the bot/user.
        // We don't enforce a specific login here (OSS — anyone can post) — the marker + URL allowlist are
        // the structural safeguards.
        return parsed;
      })
      .filter((x): x is TikTestVideo => !!x)
      // Newest first.
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    // Skip PRs with no video — the feed is for reviewable videos.
    if (videos.length === 0) continue;

    const approvals = reviews.data.filter((r) => r.state === "APPROVED").length;
    const changesRequested = reviews.data.filter((r) => r.state === "CHANGES_REQUESTED").length;

    let ciState: OpenPR["ciState"] = "unknown";
    if (status?.data.state) {
      const s = status.data.state.toLowerCase();
      if (s === "success" || s === "failure" || s === "error" || s === "pending") ciState = s as any;
    }

    out.push({
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
    });
  }
  return out;
}

/** Post a formal PR review on the user's behalf. */
export async function submitReview(input: {
  owner: string;
  repo: string;
  number: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ok = await getOctokit();
  if (!ok) return { ok: false, error: "Not signed in." };
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
