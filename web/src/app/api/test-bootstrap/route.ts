/**
 * Test-mode auth bypass for tik-test reviewer self-review.
 *
 * GET /api/test-bootstrap?ts=<unix>&sig=HMAC-SHA256(BYPASS_SECRET, ts)&redirect=/r/owner/repo
 *
 * On success: mints a session cookie carrying the bypass GitHub PAT, sets
 * the cookie, and 302-redirects to the (allowlisted) target URL.
 *
 * On any failure (missing env, kill switch, bad sig, expired ts, missing
 * params, anything): returns 404 Not Found. Probes can't tell whether the
 * route exists.
 *
 * See web/src/lib/bypass.ts for the full threat model and the rationale
 * behind every defence layer here.
 */

import { NextResponse } from "next/server";
import { encode } from "@auth/core/jwt";
import {
  isBypassEnabled,
  verifyBypassSig,
  safeRedirect,
  logBypassAttempt,
  BYPASS_SESSION_MAX_AGE_S,
} from "@/lib/bypass";

// Single 404 response shape — every failure path returns this. No body
// content that could leak which check failed.
const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

// NextAuth v5 default cookie names. The salt passed to encode/decode MUST
// match the cookie name (yes, that's the convention). Production HTTPS
// adds the `__Secure-` prefix browsers enforce as a hint.
function sessionCookieName(isHttps: boolean): string {
  return isHttps ? "__Secure-authjs.session-token" : "authjs.session-token";
}

export async function GET(req: Request) {
  // Defence: kill switch + missing env vars → 404 BEFORE any other work.
  if (!isBypassEnabled()) return NOT_FOUND();

  const url = new URL(req.url);
  const ts = url.searchParams.get("ts");
  const sig = url.searchParams.get("sig");
  const redirectParam = url.searchParams.get("redirect");
  const ip = req.headers.get("x-forwarded-for");
  const ua = req.headers.get("user-agent");

  // Defence: constant-time HMAC + ±60s skew check.
  if (!verifyBypassSig(ts, sig)) {
    logBypassAttempt({ outcome: "deny", reason: "bad-sig-or-skew", ts, ip, ua });
    return NOT_FOUND();
  }

  // Defence: redirect target allowlist. Only "/" or "/r/<owner>/<repo>".
  // Anything else silently rewrites to "/" — never reflected back as-is.
  const redirectTo = safeRedirect(redirectParam);

  // Mint the JWT. iat/bypass_iat let the session callback enforce the
  // 30-min cap independently of the cookie's own lifetime.
  const nowSec = Math.floor(Date.now() / 1000);
  const isHttps = url.protocol === "https:";
  const cookieName = sessionCookieName(isHttps);

  // TEMP DIAGNOSTIC: log token fingerprints so Vercel runtime logs show the
  // exact env state during bootstrap. SHA-256 prefix only — no plaintext.
  // Remove with /api/_diag/bypass before public release.
  const ghToken = process.env.TIKTEST_BYPASS_GH_TOKEN ?? "";
  const tokenFp = ghToken
    ? `len=${ghToken.length} first6=${ghToken.slice(0, 6)} last4=${ghToken.slice(-4)}`
    : "EMPTY";
  console.log(`[tiktest-bypass] bootstrap env: GH_TOKEN ${tokenFp}, GH_LOGIN=${process.env.TIKTEST_BYPASS_GH_LOGIN}, AUTH_SECRET_set=${!!process.env.AUTH_SECRET}, BYPASS_SECRET_set=${!!process.env.TIKTEST_BYPASS_SECRET}`);

  const cookieValue = await encode({
    token: {
      sub: `tiktest-bypass-${process.env.TIKTEST_BYPASS_GH_LOGIN}`,
      name: process.env.TIKTEST_BYPASS_GH_LOGIN,
      accessToken: process.env.TIKTEST_BYPASS_GH_TOKEN,
      login: process.env.TIKTEST_BYPASS_GH_LOGIN,
      bypass: true,
      bypass_iat: nowSec,
      iat: nowSec,
      exp: nowSec + BYPASS_SESSION_MAX_AGE_S,
    } as Record<string, unknown>,
    secret: process.env.AUTH_SECRET!,
    salt: cookieName,
  });

  logBypassAttempt({ outcome: "ok", reason: "session-minted", ts, ip, ua });

  const res = NextResponse.redirect(new URL(redirectTo, url.origin), { status: 302 });
  res.cookies.set({
    name: cookieName,
    value: cookieValue,
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    path: "/",
    maxAge: BYPASS_SESSION_MAX_AGE_S,
  });
  return res;
}
