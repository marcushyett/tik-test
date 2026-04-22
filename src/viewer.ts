import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(process.env.TIK_RUNS_DIR ?? path.join(process.cwd(), "runs"));
const WEB_DIR = path.resolve(__dirname, "..", "viewer");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function resolveFile(p: string): Promise<string | null> {
  try {
    const s = await stat(p);
    if (s.isFile()) return p;
  } catch {}
  return null;
}

async function listRuns(): Promise<Array<{ id: string; name: string; finishedAt: string; totalMs: number; passed: number; failed: number; skipped: number; total: number; highlights: boolean }>> {
  try {
    const entries = await readdir(ROOT, { withFileTypes: true });
    const runs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(ROOT, e.name);
      try {
        const evPath = path.join(dir, "events.json");
        const hl = path.join(dir, "highlights.mp4");
        const events = JSON.parse(await readFile(evPath, "utf8"));
        const total = events.events.length;
        const passed = events.events.filter((x: any) => x.outcome === "success").length;
        const failed = events.events.filter((x: any) => x.outcome === "failure").length;
        const skipped = events.events.filter((x: any) => x.outcome === "skipped").length;
        const hlExists = !!(await resolveFile(hl));
        runs.push({
          id: e.name,
          name: events.plan?.name ?? e.name,
          finishedAt: events.finishedAt,
          totalMs: events.totalMs,
          passed, failed, skipped, total,
          highlights: hlExists,
        });
      } catch {}
    }
    runs.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    return runs;
  } catch {
    return [];
  }
}

async function serve(req: any, res: any) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/api/runs") {
      const runs = await listRuns();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(runs));
      return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
    if (runMatch) {
      const id = runMatch[1];
      const file = path.join(ROOT, id, "events.json");
      const f = await resolveFile(file);
      if (!f) { res.writeHead(404); res.end("not found"); return; }
      const body = await readFile(f);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    const assetMatch = /^\/runs\/([^/]+)\/(.+)$/.exec(pathname);
    if (assetMatch) {
      const [, id, rel] = assetMatch;
      const full = path.join(ROOT, id, rel);
      if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const f = await resolveFile(full);
      if (!f) { res.writeHead(404); res.end("not found"); return; }
      const s = await stat(f);
      const ext = path.extname(f).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      const range = req.headers.range;
      if (range && (ext === ".mp4" || ext === ".webm")) {
        const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : s.size - 1;
        const chunk = end - start + 1;
        const { createReadStream } = await import("node:fs");
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Range": `bytes ${start}-${end}/${s.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunk,
        });
        createReadStream(f, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": s.size });
      const { createReadStream } = await import("node:fs");
      createReadStream(f).pipe(res);
      return;
    }

    // Static viewer
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const staticPath = path.join(WEB_DIR, rel);
    if (!staticPath.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
    const f = await resolveFile(staticPath);
    if (f) {
      const ext = path.extname(f).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      const body = await readFile(f);
      res.writeHead(200, { "Content-Type": type });
      res.end(body);
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500);
    res.end((e as Error).message);
  }
}

export function startViewer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer(serve);
    server.listen(port, () => {
      console.log(chalk.green(`\n  ✨ viewer running at ${chalk.underline(`http://localhost:${port}`)}\n`));
      resolve();
    });
  });
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 5173);
  startViewer(port);
}
