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

/**
 * Parse `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>` into
 * parts we can use to hit the GitHub API. The raw browser URL 404s for private
 * repos even with a valid Bearer token; the authenticated path is the API
 * endpoint `/repos/{o}/{r}/releases/assets/{id}` with
 * `Accept: application/octet-stream`, which redirects to the signed CDN URL.
 */
function parseReleaseUrl(raw: string): { owner: string; repo: string; tag: string; asset: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^?]+)/i.exec(raw);
  if (!m) return null;
  return { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]), asset: decodeURIComponent(m[4]) };
}

async function resolveAssetApiUrl(
  parts: { owner: string; repo: string; tag: string; asset: string },
  token: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${parts.owner}/${parts.repo}/releases/tags/${encodeURIComponent(parts.tag)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "tik-test-review" } },
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null) as { assets?: Array<{ name: string; url: string }> } | null;
  const asset = data?.assets?.find((a) => a.name === parts.asset);
  return asset?.url ?? null;
}

export async function GET(req: Request) {
  const session = (await auth()) as any;
  const token: string | undefined = session?.accessToken;
  if (!token) return new NextResponse("Not signed in", { status: 401 });

  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });
  if (!ALLOWED.some((r) => r.test(raw))) return new NextResponse("Disallowed host", { status: 403 });

  const range = req.headers.get("range") ?? undefined;

  // Resolve to the API-path URL so GitHub accepts the reviewer's Bearer token.
  // If that fails (missing tag, unknown asset, or the reviewer's token can't
  // read the repo), we surface the failure directly — the video is only
  // viewable by reviewers who have access to the PR's repo, which is exactly
  // the model we want.
  const parts = parseReleaseUrl(raw);
  const apiUrl = parts ? await resolveAssetApiUrl(parts, token) : null;
  const upstreamUrl = apiUrl ?? raw;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Asking for octet-stream nudges the API to 302 us to the signed CDN
      // URL; without it we'd get JSON metadata or an HTML landing page.
      Accept: "application/octet-stream",
      ...(range ? { Range: range } : {}),
      "User-Agent": "tik-test-review",
    },
    // Follow the 302 to the signed URL; the signed URL has its own auth and
    // doesn't need the Bearer token, so the PAT never leaves our fetch.
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
