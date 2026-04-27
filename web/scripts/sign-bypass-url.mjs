#!/usr/bin/env node
/**
 * Generate a signed, time-bound URL for the tik-test reviewer's
 * /api/test-bootstrap endpoint.
 *
 * Usage:
 *   TIKTEST_BYPASS_SECRET=... \
 *     node web/scripts/sign-bypass-url.mjs \
 *       --base https://tik-test-review.vercel.app \
 *       --redirect /r/marcushyett/tik-test
 *
 * Or piecewise:
 *   ts=$(date +%s)
 *   sig=$(printf '%s' "$ts" | openssl dgst -sha256 -hmac "$BYPASS_SECRET" -hex | awk '{print $2}')
 *   echo "https://app/api/test-bootstrap?ts=$ts&sig=$sig"
 *
 * The URL is valid for ~60 seconds from generation. Don't pre-bake URLs;
 * generate them at the moment you're about to use them.
 */
import { createHmac } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const base = args.base ?? args.b;
const redirect = args.redirect ?? args.r ?? "/";
const secret = process.env.TIKTEST_BYPASS_SECRET;

if (!base) usage("missing --base");
if (!secret) usage("TIKTEST_BYPASS_SECRET env var is empty");

const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", secret).update(ts).digest("hex");

const u = new URL("/api/test-bootstrap", base);
u.searchParams.set("ts", ts);
u.searchParams.set("sig", sig);
u.searchParams.set("redirect", redirect);
process.stdout.write(u.toString() + "\n");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    } else if (a.startsWith("-") && a.length === 2) {
      const k = a.slice(1);
      const v = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}
function usage(msg) {
  process.stderr.write(`error: ${msg}\n\n`);
  process.stderr.write(`usage: TIKTEST_BYPASS_SECRET=... node sign-bypass-url.mjs --base <url> [--redirect <path>]\n`);
  process.exit(2);
}
