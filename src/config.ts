import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config, TestPlan } from "./types.js";

const SECTION_RE = /^##\s+(.+?)\s*$/;
const SUBSECTION_RE = /^###\s+(.+?)\s*$/;
const TIKTEST_HEADING_RE = /^##\s+tik[- ]?test\b.*$/i;
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

/**
 * Pull the body of a `## TikTest` section from a README, then parse its
 * `### URL` / `### Login` / `### Setup` / `### Focus` / `### Test Plan`
 * sub-sections. Anything in the section body BEFORE any sub-heading is
 * treated as a free-form description that becomes the agent's focus copy.
 *
 * Returns null if no `## TikTest` heading exists. Returns the parsed
 * fragment otherwise so the caller can merge with frontmatter / overrides.
 */
function extractTiktestSection(body: string): {
  url?: string;
  login?: string;
  setup?: string;
  focus?: string;
  plan?: string;
  description?: string;
} | null {
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TIKTEST_HEADING_RE.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) { end = i; break; }
  }
  const sub = new Map<string, string>();
  let intro: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  for (let i = start; i < end; i++) {
    const m = SUBSECTION_RE.exec(lines[i]);
    if (m) {
      if (current) sub.set(current.toLowerCase(), buf.join("\n").trim());
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(lines[i]);
    } else {
      intro.push(lines[i]);
    }
  }
  if (current) sub.set(current.toLowerCase(), buf.join("\n").trim());

  return {
    url: sub.get("url"),
    login: sub.get("login"),
    setup: sub.get("setup"),
    focus: sub.get("focus") ?? sub.get("changes"),
    plan: sub.get("test plan") ?? sub.get("plan"),
    description: intro.join("\n").trim() || undefined,
  };
}

export async function loadConfig(configPath: string, urlOverride?: string): Promise<Config> {
  const abs = path.resolve(configPath);
  const raw = await readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const sections = parseSections(body);
  const tiktest = extractTiktestSection(body);

  // Resolution order: explicit override > README's `## TikTest > ### URL` >
  // top-level `## URL` (claude.md style) > frontmatter > error.
  const url = urlOverride ?? tiktest?.url ?? sections.get("url") ?? data.url ?? "";
  if (!url) {
    throw new Error(
      `No URL provided. Add a "## TikTest" section to your README.md with a "### URL" sub-section ` +
      `containing the preview URL, or pass --url.`,
    );
  }

  const viewport = (() => {
    const v = data.viewport ?? sections.get("viewport") ?? "1280x800";
    const m = /^(\d+)\s*x\s*(\d+)$/i.exec(v.trim());
    return m ? { width: +m[1], height: +m[2] } : { width: 1280, height: 800 };
  })();

  const planSrc = tiktest?.plan ?? sections.get("test plan") ?? sections.get("plan");
  let plan: TestPlan | undefined;
  if (planSrc) {
    const json = extractJsonBlock(planSrc);
    if (json) plan = JSON.parse(json) as TestPlan;
  }

  // Focus prefers the README's `## TikTest > ### Focus`; falls back to its
  // free-form intro paragraph (everything between `## TikTest` and the
  // first sub-heading); then top-level legacy sections.
  const focus = tiktest?.focus
    ?? tiktest?.description
    ?? sections.get("focus")
    ?? sections.get("changes")
    ?? sections.get("pr summary");

  return {
    url,
    name: data.name ?? sections.get("name"),
    viewport,
    setup: tiktest?.setup ?? sections.get("setup"),
    login: tiktest?.login ?? sections.get("login"),
    focus,
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
  if (cfg.comments) parts.push(`PR comments (teammate feedback / suggestions — incorporate any "make sure to test X" hints):\n${cfg.comments}`);
  return parts.join("\n\n");
}
