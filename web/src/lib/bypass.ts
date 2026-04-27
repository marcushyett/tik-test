/**
 * Test-mode auth bypass for tik-test reviewer self-review.
 *
 * THREAT MODEL & DEFENCES (read this before changing anything):
 *
 *  - Bypass URL is `?ts=<unix>&sig=HMAC-SHA256(SECRET, ts)`. The server
 *    rejects if `|now - ts| > MAX_SKEW_S` so a URL captured from a log line
 *    is dead within ~60 seconds.
 *  - Sig comparison uses `crypto.timingSafeEqual`. No early-exit string
 *    compare — same code path for "wrong sig" and "right sig but stale".
 *  - All response codes are `404 Not Found` on any failure (missing env,
 *    kill switch, bad sig, expired ts). The presence/absence of the bypass
 *    is indistinguishable to a probe.
 *  - Sessions minted by the bypass carry a `bypass: true` JWT claim.
 *    Write-capable server actions (currently only `submitReview`) refuse
 *    to run under that claim. Worst case from a leaked bypass session =
 *    read the same data anyone with a PAT for the repo could read.
 *  - Bypass session has an `iat` claim and a 30-min server-side check; the
 *    cookie itself is also short-lived. Either expiry path closes it.
 *  - Kill switch: setting `TIKTEST_BYPASS_DISABLED=1` (or any truthy value)
 *    in Vercel env disables the route instantly with no redeploy.
 *  - Fail-closed: if `BYPASS_SECRET`, `BYPASS_GH_TOKEN`, or `BYPASS_GH_LOGIN`
 *    is missing, the route 404s. There is no degraded mode.
 *
 * The PAT used should be a fine-grained PAT scoped to ONLY the repo under
 * test, with read-only permissions (Contents: Read, Metadata: Read,
 * Pull requests: Read). Even a fully-leaked PAT then has the blast radius
 * of "read public PR data on one public repo".
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const BYPASS_SESSION_MAX_AGE_S = 30 * 60;   // 30 min — total session lifetime
export const BYPASS_URL_MAX_SKEW_S    = 60;        // ±60s — how stale a signed URL may be

/** True when ALL required env vars are populated AND the kill switch is off. */
export function isBypassEnabled(): boolean {
  if (process.env.TIKTEST_BYPASS_DISABLED && process.env.TIKTEST_BYPASS_DISABLED !== "0") return false;
  return Boolean(
    process.env.TIKTEST_BYPASS_SECRET &&
    process.env.TIKTEST_BYPASS_GH_TOKEN &&
    process.env.TIKTEST_BYPASS_GH_LOGIN &&
    process.env.AUTH_SECRET, // needed to sign the session cookie
  );
}

/**
 * Constant-time HMAC verification of a `ts`/`sig` pair against
 * `TIKTEST_BYPASS_SECRET`. Returns false on:
 *   - missing/non-numeric ts
 *   - sig wrong length / not hex
 *   - sig mismatch
 *   - ts skew greater than BYPASS_URL_MAX_SKEW_S
 *
 * Same code path / similar timing for every failure mode — caller should
 * not branch on the reason for failure when forming the response.
 */
export function verifyBypassSig(ts: string | null, sig: string | null): boolean {
  const secret = process.env.TIKTEST_BYPASS_SECRET;
  if (!secret) return false;
  if (!ts || !sig) return false;
  if (!/^\d{10,12}$/.test(ts)) return false;
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;

  // Compute expected sig and compare in constant time. Both buffers are
  // exactly 32 bytes (64 hex chars) so timingSafeEqual won't throw.
  const expected = createHmac("sha256", secret).update(ts).digest();
  let provided: Buffer;
  try { provided = Buffer.from(sig, "hex"); } catch { return false; }
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(expected, provided)) return false;

  // Time-bound check AFTER the constant-time compare so an attacker can't
  // probe (sig, ts) pairs by timing-distinguishing skew vs sig-mismatch.
  const tsNum = Number(ts);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > BYPASS_URL_MAX_SKEW_S) return false;
  return true;
}

/**
 * Whitelisted post-bypass redirect targets. We only allow:
 *   - `/`
 *   - `/r/<owner>/<repo>` (with normal GitHub-name char set)
 * Anything else falls back to `/`. This prevents the bypass route from
 * being abused as an open redirect.
 */
export function safeRedirect(target: string | null): string {
  if (!target) return "/";
  if (target === "/") return "/";
  if (/^\/r\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/?$/.test(target)) return target;
  return "/";
}

/**
 * One-line audit record emitted via console.log. In Vercel this lands in
 * the standard runtime logs and is searchable with the Logs UI / Drains.
 * Keep the format stable so log-based alerts can match on it.
 */
export function logBypassAttempt(args: { outcome: "ok" | "deny"; reason: string; ts: string | null; ip: string | null; ua: string | null }): void {
  const safeUa = (args.ua ?? "").slice(0, 80).replace(/[\r\n\t]/g, " ");
  const safeIp = (args.ip ?? "").split(",")[0].trim().slice(0, 64);
  console.log(
    `[tiktest-bypass] outcome=${args.outcome} reason=${args.reason} ts=${args.ts ?? "-"} ip=${safeIp || "-"} ua=${JSON.stringify(safeUa)}`,
  );
}

/** Returns true if a session JWT is past the 30-minute bypass cap. Used by
 *  the session callback to invalidate stale bypass sessions even when the
 *  cookie is still otherwise valid. */
export function isBypassSessionExpired(bypass_iat: unknown): boolean {
  if (typeof bypass_iat !== "number") return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - bypass_iat > BYPASS_SESSION_MAX_AGE_S;
}
