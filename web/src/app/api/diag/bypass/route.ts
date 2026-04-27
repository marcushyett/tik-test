/**
 * TEMPORARY diagnostic endpoint for debugging the test-mode bypass flow.
 *
 *   GET /api/diag/bypass
 *
 * Gated to bypass-session callers only — `auth()` must return a session
 * with `bypass === true`. A normal GitHub-OAuth session, an unauthed
 * request, or no session at all → 404 (same shape as
 * `/api/test-bootstrap` to keep probes non-discoverable).
 *
 * Returns a JSON snapshot intended ONLY for the maintainer:
 *
 *   - presence of each required env var (boolean — never the value)
 *   - SHA-256 prefix of TIKTEST_BYPASS_GH_TOKEN (8 hex chars — lets us
 *     compare against the local PAT's hash without leaking the secret)
 *   - the resolved session shape (accessToken length + first 6 chars +
 *     last 4 chars, login, bypass flag)
 *   - live result of calling GitHub `/user` and
 *     `/user/repos?per_page=5` with the PAT — the EXACT calls
 *     `lib/github.ts:getOctokit` would make
 *
 * **Remove this file before public release** — `/api/diag/*` is a path
 * convention for temporary debugging only. The bypass-session gate +
 * sub-millisecond constant-time-equal on the prefix means a leaked
 * URL only exposes hashed fingerprints, but it's still extra surface
 * area we don't want long-term.
 *
 * NOTE: a previous version lived under `/api/_diag/bypass` — Next.js
 * App Router treats folders prefixed with `_` as PRIVATE and skips them
 * for routing, so the route silently 404'd. The directory was renamed
 * to drop the underscore.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { auth } from "@/auth";

const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

function fingerprint(value: string | undefined): { present: boolean; length: number; sha256_prefix?: string; first6?: string; last4?: string } {
  if (!value) return { present: false, length: 0 };
  const h = createHash("sha256").update(value).digest("hex");
  return {
    present: true,
    length: value.length,
    sha256_prefix: h.slice(0, 8),
    first6: value.slice(0, 6),
    last4: value.slice(-4),
  };
}

export async function GET() {
  // Gate: only callable from a bypass session.
  const session = await auth();
  if (!session || session.bypass !== true) {
    return NOT_FOUND();
  }

  const token = session.accessToken;

  // Live GitHub probes — exactly what lib/github.ts:getOctokit ends up
  // doing. We catch + return status instead of throwing, so a failure
  // mode shows up in the JSON instead of a 500.
  let userResult: { ok: boolean; status?: number; login?: string; error?: string } = { ok: false };
  let reposResult: { ok: boolean; status?: number; count?: number; first?: string; error?: string } = { ok: false };

  if (token) {
    try {
      const r = await fetch("https://api.github.com/user", {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
      });
      const body = r.ok ? await r.json() : null;
      userResult = { ok: r.ok, status: r.status, login: body?.login ?? undefined };
    } catch (e) {
      userResult = { ok: false, error: (e as Error).message };
    }

    try {
      const r = await fetch(
        "https://api.github.com/user/repos?sort=pushed&per_page=5&affiliation=owner,collaborator,organization_member",
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } },
      );
      const body = r.ok ? await r.json() : null;
      reposResult = {
        ok: r.ok,
        status: r.status,
        count: Array.isArray(body) ? body.length : undefined,
        first: Array.isArray(body) ? body[0]?.full_name : undefined,
      };
    } catch (e) {
      reposResult = { ok: false, error: (e as Error).message };
    }
  }

  return NextResponse.json(
    {
      now: new Date().toISOString(),
      env: {
        AUTH_SECRET: fingerprint(process.env.AUTH_SECRET).present ? { present: true, length: process.env.AUTH_SECRET!.length } : { present: false, length: 0 },
        TIKTEST_BYPASS_SECRET: fingerprint(process.env.TIKTEST_BYPASS_SECRET).present ? { present: true, length: process.env.TIKTEST_BYPASS_SECRET!.length } : { present: false, length: 0 },
        TIKTEST_BYPASS_GH_TOKEN: fingerprint(process.env.TIKTEST_BYPASS_GH_TOKEN),
        TIKTEST_BYPASS_GH_LOGIN: fingerprint(process.env.TIKTEST_BYPASS_GH_LOGIN).present
          ? { present: true, length: process.env.TIKTEST_BYPASS_GH_LOGIN!.length, value: process.env.TIKTEST_BYPASS_GH_LOGIN }
          : { present: false, length: 0 },
        GITHUB_CLIENT_ID: fingerprint(process.env.GITHUB_CLIENT_ID).present ? { present: true, length: process.env.GITHUB_CLIENT_ID!.length } : { present: false, length: 0 },
        GITHUB_CLIENT_SECRET: fingerprint(process.env.GITHUB_CLIENT_SECRET).present ? { present: true, length: process.env.GITHUB_CLIENT_SECRET!.length } : { present: false, length: 0 },
      },
      session: {
        bypass: session.bypass === true,
        login: session.login,
        accessToken: fingerprint(token),
      },
      env_token_matches_session_token: token && process.env.TIKTEST_BYPASS_GH_TOKEN
        ? createHash("sha256").update(token).digest("hex") === createHash("sha256").update(process.env.TIKTEST_BYPASS_GH_TOKEN).digest("hex")
        : null,
      githubProbes: {
        user: userResult,
        repos_5: reposResult,
      },
    },
    { status: 200 },
  );
}
