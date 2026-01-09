// Deno won't necessarily be here, which is why we forward declare it
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const Deno: {
  readTextFile(path: string): Promise<string>;
  Command: new (
    command: string,
    options: { args: string[]; stdout?: "piped"; stderr?: "piped" }
  ) => {
    output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  };
};

import { getEnvValue } from "./env.ts";

const ROOT_SEARCH_PATHS = [".", "..", "../..", "../../..", "../../../..", "../../../../..", "../../../../../..", "../../../../../../.."];
const COMMIT_HASH_LEN = 7;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

async function readTextFile(path: string): Promise<string | null> {
  if (typeof Deno !== "undefined") {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return null;
    }
  }

  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function toShortCommitHash(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !COMMIT_HASH_RE.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_LEN);
}

function parseGitDirFromDotGitFile(content: string): string | null {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
  const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
  return match?.[1]?.trim() ?? null;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

async function readGitHeadShortRevision(gitDir: string): Promise<string | null> {
  const head = await readTextFile(`${gitDir}/HEAD`);
  if (!head) {
    return null;
  }
  const trimmedHead = head.trim();
  const refMatch = trimmedHead.match(/^ref:\s*(.+)\s*$/);
  if (!refMatch) {
    return toShortCommitHash(trimmedHead);
  }

  const refPath = refMatch[1]?.trim();
  if (!refPath) {
    return null;
  }
  if (isAbsolutePath(refPath) || refPath.includes("..")) {
    return null;
  }

  const ref = await readTextFile(`${gitDir}/${refPath}`);
  if (ref) {
    return toShortCommitHash(ref.trim());
  }

  const packedRefs = await readTextFile(`${gitDir}/packed-refs`);
  if (!packedRefs) {
    return null;
  }

  for (const line of packedRefs.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) {
      continue;
    }
    const space = trimmed.indexOf(" ");
    if (space === -1) {
      continue;
    }
    const hash = trimmed.slice(0, space).trim();
    const refName = trimmed.slice(space + 1).trim();
    if (refName === refPath) {
      return toShortCommitHash(hash);
    }
  }

  return null;
}

async function runGitCommand(args: string[]): Promise<string | null> {
  try {
    if (typeof Deno !== "undefined") {
      const command = new Deno.Command("git", { args });
      const { code, stdout } = await command.output();
      if (code === 0) {
        return new TextDecoder().decode(stdout).trim();
      }
    } else {
      // Node.js fallback
      const { execFileSync } = await import("child_process");
      return execFileSync("git", args, { encoding: "utf8" }).trim();
    }
  } catch {
    return null;
  }
}

export async function getKernelCommit(): Promise<string> {
  const envHash = toShortCommitHash(getEnvValue("GIT_REVISION") ?? getEnvValue("GITHUB_SHA"));
  if (envHash) {
    return envHash;
  }

  try {
    const gitHash = await runGitCommand(["rev-parse", "--short", "HEAD"]);
    if (gitHash) {
      return gitHash.trim();
    }
  } catch {
    // git command not available, fall back to file reading
  }

  for (const root of ROOT_SEARCH_PATHS) {
    const dotGitHead = await readTextFile(`${root}/.git/HEAD`);
    if (dotGitHead) {
      const revision = await readGitHeadShortRevision(`${root}/.git`);
      if (revision) {
        return revision;
      }
    }

    const dotGitFile = await readTextFile(`${root}/.git`);
    if (!dotGitFile) {
      continue;
    }
    const gitDir = parseGitDirFromDotGitFile(dotGitFile);
    if (!gitDir) {
      continue;
    }
    const resolvedGitDir = isAbsolutePath(gitDir) ? gitDir : `${root}/${gitDir}`;
    const revision = await readGitHeadShortRevision(resolvedGitDir);
    if (revision) {
      return revision;
    }
  }

  return "unknown";
}
