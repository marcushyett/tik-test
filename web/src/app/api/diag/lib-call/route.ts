/**
 * TEMPORARY diagnostic endpoint that calls the IMPORTED `listPRsWithVideos`
 * function (the one with `"use server"` directive in lib/github.ts) and
 * returns whatever it sees. Pairs with /api/diag/pr-feed which reimplements
 * the same logic inline. If pr-feed returns 10 PRs but lib-call returns
 * 0, the bug is specific to the lib/github.ts code path (probably the
 * `"use server"` directive interacting badly with the Server Component
 * call context).
 *
 *   GET /api/diag/lib-call
 *
 * Bypass-session-only.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listPRsWithVideos, listRepos } from "@/lib/github";

const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

export async function GET() {
  const session = await auth();
  if (!session || session.bypass !== true) return NOT_FOUND();

  // Call the imported lib functions. If these return [] here despite the
  // pr-feed route returning data, the difference is the "use server"
  // directive's effect on internals (auth() resolution, fetch context,
  // module-graph caching, etc.).
  let repos: { count: number; first?: string; error?: string };
  try {
    const r = await listRepos();
    repos = { count: r.length, first: r[0]?.full_name };
  } catch (e) {
    repos = { count: 0, error: (e as Error).message };
  }

  let pr: { count: number; numbers?: number[]; error?: string };
  try {
    const r = await listPRsWithVideos("marcushyett", "tik-test");
    pr = { count: r.length, numbers: r.map((p) => p.number) };
  } catch (e) {
    pr = { count: 0, error: (e as Error).message };
  }

  return NextResponse.json({
    note: "Calling the IMPORTED lib/github.ts functions directly. Compare with /api/diag/pr-feed which uses raw Octokit.",
    listRepos: repos,
    listPRsWithVideos: pr,
  });
}
