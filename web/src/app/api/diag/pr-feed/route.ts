/**
 * TEMPORARY diagnostic endpoint: probes `listPRsWithVideos` for a fixed
 * (owner, repo) and returns the per-step result (PR list, per-PR comment
 * scan + marker parse) WITHOUT relying on Server Component caching or
 * rendering. Pairs with /api/diag/bypass — this one isolates the
 * `pulls.list` call that's mysteriously returning empty in production
 * even though the same call works perfectly via curl with the same PAT.
 *
 *   GET /api/diag/pr-feed
 *
 * Bypass-session-only. Returns 404 to anything else (same shape as
 * `/api/test-bootstrap`). Remove alongside `/api/diag/bypass`.
 */

import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { auth } from "@/auth";
import { parseMarker } from "@/lib/marker";

const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

// Hard-coded to this repo for now — the diagnostic is only meaningful
// against the repo we're trying to debug, and pinning the value means
// we can't be tricked into probing arbitrary repos.
const TARGET_OWNER = "marcushyett";
const TARGET_REPO = "tik-test";

export async function GET() {
  const session = await auth();
  if (!session || session.bypass !== true) return NOT_FOUND();

  const token = session.accessToken;
  if (!token) {
    return NextResponse.json({ error: "session has no accessToken", session: { bypass: session.bypass, login: session.login } });
  }

  const ok = new Octokit({ auth: token });

  let prsList: { ok: boolean; status?: number; count?: number; numbers?: number[]; error?: string };
  try {
    const r = await ok.pulls.list({
      owner: TARGET_OWNER,
      repo: TARGET_REPO,
      state: "open",
      per_page: 30,
      sort: "updated",
      direction: "desc",
    });
    prsList = {
      ok: true,
      status: r.status,
      count: r.data.length,
      numbers: r.data.map((p) => p.number),
    };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    prsList = { ok: false, status: err.status, error: err.message };
  }

  // For each PR returned, also probe its comments + show how the marker
  // parse went. Reveals whether (a) the PR is being skipped because of
  // missing markers, or (b) marker parse is failing despite a valid
  // comment.
  const perPr: Array<{
    number: number;
    commentsCount?: number;
    commentsError?: string;
    markersFound?: number;
    rawMarkerPreview?: string | null;
  }> = [];

  if (prsList.ok && prsList.numbers) {
    for (const num of prsList.numbers.slice(0, 5)) {
      try {
        const c = await ok.issues.listComments({
          owner: TARGET_OWNER,
          repo: TARGET_REPO,
          issue_number: num,
          per_page: 100,
        });
        const validMarkers = c.data
          .map((com) => parseMarker(com.body ?? ""))
          .filter((m) => m !== null);
        const firstMarkerComment = c.data.find((com) => /tik-test-video:v/.test(com.body ?? ""));
        const rawMarkerPreview = firstMarkerComment?.body
          ? firstMarkerComment.body.slice(0, 240) + (firstMarkerComment.body.length > 240 ? "…" : "")
          : null;
        perPr.push({
          number: num,
          commentsCount: c.data.length,
          markersFound: validMarkers.length,
          rawMarkerPreview,
        });
      } catch (e) {
        const err = e as { status?: number; message?: string };
        perPr.push({ number: num, commentsError: `${err.status}: ${err.message}` });
      }
    }
  }

  return NextResponse.json({
    target: `${TARGET_OWNER}/${TARGET_REPO}`,
    session: {
      bypass: session.bypass === true,
      login: session.login,
      tokenPrefix: token ? `${token.slice(0, 14)}…(len=${token.length})` : null,
    },
    prsList,
    perPr,
  });
}
