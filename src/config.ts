import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config, TestPlan } from "./types.js";

const SECTION_RE = /^##\s+(.+?)\s*$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (k) data[k] = v;
  }
  return { data, body: src.slice(m[0].length) };
}

function parseSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (current) out.set(current.toLowerCase(), buf.join("\n").trim());
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) out.set(current.toLowerCase(), buf.join("\n").trim());
  return out;
}

function extractJsonBlock(md: string): string | null {
  const fence = /```json\r?\n([\s\S]*?)```/i.exec(md);
  return fence ? fence[1].trim() : null;
}

export async function loadConfig(configPath: string, urlOverride?: string): Promise<Config> {
  const abs = path.resolve(configPath);
  const raw = await readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const sections = parseSections(body);

  const url = urlOverride ?? data.url ?? sections.get("url") ?? "";
  if (!url) throw new Error(`No URL provided. Set "url:" in frontmatter, a "## URL" section, or pass --url.`);

  const viewport = (() => {
    const v = data.viewport ?? sections.get("viewport") ?? "1280x800";
    const m = /^(\d+)\s*x\s*(\d+)$/i.exec(v.trim());
    return m ? { width: +m[1], height: +m[2] } : { width: 1280, height: 800 };
  })();

  const planSrc = sections.get("test plan") ?? sections.get("plan");
  let plan: TestPlan | undefined;
  if (planSrc) {
    const json = extractJsonBlock(planSrc);
    if (json) plan = JSON.parse(json) as TestPlan;
  }

  return {
    url,
    name: data.name ?? sections.get("name"),
    viewport,
    setup: sections.get("setup"),
    login: sections.get("login"),
    focus: sections.get("focus") ?? sections.get("changes") ?? sections.get("pr summary"),
    plan,
    music: data.music,
  };
}

export function configToPromptContext(cfg: Config): string {
  const parts: string[] = [];
  parts.push(`Target URL: ${cfg.url}`);
  if (cfg.name) parts.push(`App: ${cfg.name}`);
  if (cfg.focus) parts.push(`Focus / changes:\n${cfg.focus}`);
  if (cfg.setup) parts.push(`Setup notes:\n${cfg.setup}`);
  if (cfg.login) parts.push(`Login:\n${cfg.login}`);
  if (cfg.diff) parts.push(`PR code diff (authoritative — test the surfaces these hunks touch):\n${cfg.diff}`);
  return parts.join("\n\n");
}
