import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Streaming proxy for tik-test video / gif assets.
 *
 * GitHub release-asset URLs on **private repos** 401 for unauthenticated
 * browsers, so the `<video src>` tag shows the unsupported-source "play
 * button with a line through it". The fix is to proxy those downloads
 * through a Next.js route that forwards the signed-in user's GitHub token.
 *
 * Security:
 *  - We only accept `https://github.com/<owner>/<repo>/releases/download/...`
 *    URLs (same allowlist as the comment-marker parser). That's the only
 *    surface our own tik-test CLI uploads to.
 *  - We require a valid session — so anyone who can't already read the repo
 *    can't use this proxy as an oracle.
 *  - We forward Range headers so the browser can seek without re-downloading
 *    the whole file.
 */

const ALLOWED = [/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i];

export async function GET(req: Request) {
  const session = (await auth()) as any;
  const token: string | undefined = session?.accessToken;
  if (!token) return new NextResponse("Not signed in", { status: 401 });

  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });
  if (!ALLOWED.some((r) => r.test(raw))) return new NextResponse("Disallowed host", { status: 403 });

  const range = req.headers.get("range") ?? undefined;

  // The GitHub API release-asset URL has the signing we need. Bare github.com
  // release-asset URLs redirect to a short-lived objects.githubusercontent.com
  // URL that already embeds authentication — BUT only when the initial
  // 302 is followed by a client that sent a valid Bearer token. So we hit
  // github.com/.../releases/download with the token and let fetch follow.
  const upstream = await fetch(raw, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Asking for octet-stream nudges GitHub to redirect us to the signed
      // download URL; without it we'd get the HTML landing page.
      Accept: "application/octet-stream",
      ...(range ? { Range: range } : {}),
      "User-Agent": "tik-test-review",
    },
    // fetch follows the redirect automatically; the signed CDN URL doesn't
    // need the Bearer token anymore, so the body streams through without
    // leaking the PAT downstream.
    redirect: "follow",
  });

  if (!upstream.ok && upstream.status !== 206) {
    return new NextResponse(`Upstream ${upstream.status}`, { status: upstream.status });
  }

  const headers = new Headers();
  // Forward the bits the browser needs to seek + render the video.
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  // Force video/mp4 / image/gif when GitHub returns octet-stream.
  if (!headers.get("content-type") || headers.get("content-type")?.includes("octet-stream")) {
    if (/\.mp4($|\?)/i.test(raw)) headers.set("content-type", "video/mp4");
    else if (/\.gif($|\?)/i.test(raw)) headers.set("content-type", "image/gif");
  }
  headers.set("cache-control", "private, max-age=3600");

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
