import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config, TestPlan } from "./types.js";

const SECTION_RE = /^##\s+(.+?)\s*$/;
/** Recognised aliases for the heading inside a README that wraps tik-test
 *  config. Tolerant: `## TikTest`, `## tik-test`, `## tiktest setup`,
 *  `## Testing`, `## How to test`, `## Test setup`, `## Test environment`,
 *  `## Test instructions` all match. */
const TIKTEST_HEADING_RE = /^##\s+(tik[- ]?test\b|testing\b|how\s+to\s+test\b|test\s+(?:setup|environment|instructions)\b).*$/i;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** First HTTPS URL anywhere in the body. Used to bootstrap the browser
 *  before the agent runs; the agent itself reads the natural-language
 *  blob and figures out everything else (login, what to test, etc). */
const BARE_URL_RE = /\bhttps?:\/\/[^\s)\]>"'`]+/i;
/** Lines like `start: npm run dev` get spawned as a background process
 *  before the test phase. Anchored to start-of-line so prose containing
 *  the word "start:" doesn't accidentally trigger. */
const START_DIRECTIVE_RE = /^start:\s*(.+)$/im;

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

function extractJsonBlock(md: string): string | null {
  const fence = /```json\r?\n([\s\S]*?)```/i.exec(md);
  return fence ? fence[1].trim() : null;
}

/**
 * Find the chunk of the file that contains the user's testing instructions.
 *
 * The runtime philosophy: tik-test does NOT pre-parse this blob into URL /
 * login / setup / focus fields. Doing that with regex is fragile (every
 * heading variant becomes a bug report). Instead the blob is fed wholesale
 * to two separate Claude calls — the plan generator (which reads it as
 * "what does this app do, what should I test") and the setup phase (which
 * reads it as "how do I get the browser to a logged-in test-ready state").
 * Each call uses Claude's natural-language understanding to extract what
 * it needs.
 *
 * The only thing this function does is choose WHICH part of the file to
 * pass through:
 *
 *   - `tiktest.md` / `tik-test.md`: the whole file body.
 *   - `README.md` with a `## TikTest` (or alias) heading: just the body
 *     of that section, sliced from the heading to the next H2. Saves us
 *     from feeding the agent the entire README (Install, License, etc).
 *   - Anything else (claude.md, bare README.md): the whole file body.
 */
function extractInstructionsBlob(filePath: string, body: string): string {
  const fileName = path.basename(filePath).toLowerCase();
  const isDedicated = fileName === "tiktest.md" || fileName === "tik-test.md";
  if (isDedicated) return body.trim();

  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TIKTEST_HEADING_RE.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return body.trim();
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

export async function loadConfig(configPath: string, urlOverride?: string): Promise<Config> {
  const abs = path.resolve(configPath);
  const raw = await readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const blob = extractInstructionsBlob(abs, body);

  // URL bootstrap: explicit override > frontmatter `url:` > first HTTPS link
  // in the blob. We need a starting URL BEFORE the agent runs, so this is
  // the one piece we extract eagerly. Everything else stays in the blob.
  let url = urlOverride ?? data.url ?? "";
  if (!url) {
    const m = BARE_URL_RE.exec(blob);
    if (m) url = m[0];
  }
  if (!url) {
    throw new Error(
      `No URL found. Put a preview URL anywhere in your tiktest.md (or "url:" in its frontmatter), ` +
      `or pass --url. In CI, deployment_status events auto-supply the URL.`,
    );
  }

  const viewport = (() => {
    const v = data.viewport ?? "1280x800";
    const m = /^(\d+)\s*x\s*(\d+)$/i.exec(v.trim());
    return m ? { width: +m[1], height: +m[2] } : { width: 1280, height: 800 };
  })();

  // Optional inline plan: still supports `## Test Plan` for power users
  // who want deterministic coverage. JSON inside a fenced ```json``` block.
  let plan: TestPlan | undefined;
  const planMatch = /^##\s+(?:test\s*plan|plan|goals)\b.*$/im.exec(blob);
  if (planMatch) {
    const idx = blob.indexOf(planMatch[0]) + planMatch[0].length;
    const after = blob.slice(idx);
    const json = extractJsonBlock(after);
    if (json) plan = JSON.parse(json) as TestPlan;
  }

  // `start: <cmd>` directive: spawned as a background process before the
  // test phase. Lets local-dev runs auto-launch the app server.
  const startMatch = START_DIRECTIVE_RE.exec(blob);
  const setup = startMatch ? `start: ${startMatch[1].trim()}` : undefined;

  return {
    url,
    name: data.name,
    viewport,
    setup,
    // The whole blob is the agent's project-level context. The plan
    // generator reads it as "what does this app do, how do I sign in".
    // Each goal-agent reads it as "credentials I can use if the page
    // shows me a login screen."
    projectContext: blob || undefined,
    plan,
    music: data.music,
  };
}

export function configToPromptContext(cfg: Config): string {
  const parts: string[] = [];
  parts.push(`Target URL: ${cfg.url}`);
  if (cfg.name) parts.push(`App: ${cfg.name}`);
  if (cfg.projectContext) parts.push(`Project setup (from tiktest.md — applies to every PR for this app, includes login info):\n${cfg.projectContext}`);
  if (cfg.prContext) parts.push(`This PR (from PR title + description — what specifically to test in this change):\n${cfg.prContext}`);
  if (cfg.diff) parts.push(`PR code diff (authoritative — test the surfaces these hunks touch):\n${cfg.diff}`);
  if (cfg.comments) parts.push(`PR comments (teammate feedback / suggestions — incorporate any "make sure to test X" hints):\n${cfg.comments}`);
  return parts.join("\n\n");
}
