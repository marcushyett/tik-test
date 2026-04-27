#!/usr/bin/env node
// Tiny Node server for the Taskpad demo. Serves the static SPA and answers
// POST /api/suggest-priority for the AI-priority-hints feature so the
// browser sees a real network request, real response body, real status —
// not a mocked-in-JS shortcut. Replaces the old `python3 -m http.server`
// which couldn't accept POSTs.
//
// Run with: node server.js   (default port 4173, override with PORT env)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

// Keyword tiers. High wins over Low when both present in the same input —
// "fix later" should still be HIGH because the urgent intent is dominant.
// Word boundaries on each keyword so "now" doesn't fire inside "snowman".
const HIGH = ["urgent", "asap", "today", "now", "fix", "bug", "broken", "prod", "production", "deadline", "blocker", "critical"];
const LOW  = ["later", "maybe", "someday", "fyi", "research", "explore", "consider", "eventually", "wishlist", "nice-to-have"];

function suggest(text) {
  const t = String(text ?? "").toLowerCase();
  const matched = (list) => list.filter((k) => new RegExp(`\\b${escapeRe(k)}\\b`).test(t));
  const high = matched(HIGH);
  if (high.length) return { priority: "high",   confidence: clamp01(0.55 + 0.12 * high.length), matched: high };
  const low  = matched(LOW);
  if (low.length)  return { priority: "low",    confidence: clamp01(0.55 + 0.12 * low.length),  matched: low };
  return                  { priority: "normal", confidence: 0.4,                                 matched: [] };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n.toFixed(2))));

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/suggest-priority") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch { /* malformed body → empty */ }
      // Small artificial latency so the loading state actually paints. The
      // suggestion is cheap to compute; without this the spinner flickers.
      await new Promise((r) => setTimeout(r, 220));
      const out = suggest(payload.text);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD, POST" });
      res.end("Method Not Allowed");
      return;
    }

    // Static-file serve. "/" → index.html. Path-traversal guard: resolve
    // and require the result to live under ROOT.
    const urlPath = (req.url || "/").split("?")[0];
    const wanted = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = resolve(join(ROOT, "." + wanted));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(await readFile(filePath));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message || e));
  }
});

server.listen(PORT, () => console.log(`taskpad demo on http://localhost:${PORT}`));
