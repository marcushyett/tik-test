/**
 * Parser for the `<!-- tik-test-video:vN { … } -->` marker that tik-test writes
 * into PR comments. We trust a comment only if the marker is present, parseable
 * JSON, and the videoUrl lives under a github.com release-asset path. That
 * second rule is what stops a random commenter from injecting arbitrary videos
 * into the feed.
 */

export const MARKER_RE = /<!--\s*tik-test-video:v(\d+)\s+(\{[\s\S]*?\})\s*-->/;

const ALLOWED_VIDEO_HOSTS = [/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i];

export interface TikTestVideo {
  v: string;
  runId: string;
  prRef: string;
  createdAt: string;
  planName: string;
  videoUrl: string;
  gifUrl?: string;
  totalMs: number;
  stats: { total: number; passed: number; failed: number; skipped: number };
}

export function parseMarker(body: string): TikTestVideo | null {
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  try {
    const data = JSON.parse(m[2]);
    if (!data || typeof data !== "object") return null;
    if (typeof data.videoUrl !== "string") return null;
    if (!ALLOWED_VIDEO_HOSTS.some((r) => r.test(data.videoUrl))) return null;
    if (data.gifUrl && typeof data.gifUrl === "string" && !ALLOWED_VIDEO_HOSTS.some((r) => r.test(data.gifUrl))) {
      // Drop an unsafe GIF URL but keep the video — better than rejecting the whole entry.
      data.gifUrl = undefined;
    }
    return {
      v: m[1],
      runId: String(data.runId ?? ""),
      prRef: String(data.prRef ?? ""),
      createdAt: String(data.createdAt ?? ""),
      planName: String(data.planName ?? ""),
      videoUrl: data.videoUrl,
      gifUrl: data.gifUrl,
      totalMs: Number(data.totalMs ?? 0),
      stats: {
        total: Number(data.stats?.total ?? 0),
        passed: Number(data.stats?.passed ?? 0),
        failed: Number(data.stats?.failed ?? 0),
        skipped: Number(data.stats?.skipped ?? 0),
      },
    };
  } catch {
    return null;
  }
}
