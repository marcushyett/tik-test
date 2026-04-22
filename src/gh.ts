import { spawn } from "node:child_process";

interface GhRunResult { stdout: string; stderr: string; code: number }

export function gh(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<GhRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

export function ghOrThrow(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return gh(args, opts).then((r) => {
    if (r.code !== 0) throw new Error(`gh ${args.join(" ")} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
    return r.stdout;
  });
}

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export function parsePRRef(input: string): PRRef | null {
  // Full URL
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(input);
  if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
  // owner/repo#number
  const m2 = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/.exec(input);
  if (m2) return { owner: m2[1], repo: m2[2], number: Number(m2[3]), url: `https://github.com/${m2[1]}/${m2[2]}/pull/${m2[3]}` };
  // Bare PR number — only valid inside a repo working directory
  if (/^\d+$/.test(input)) {
    return null; // caller can resolve using current repo context
  }
  return null;
}
