// Deno won't necessarily be here, which is why we forward declare it
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  readTextFile(path: string): Promise<string>;
  Command: new (
    command: string,
    options: { args: string[]; stdout?: "piped"; stderr?: "piped" }
  ) => {
    output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  };
};

const ROOT_SEARCH_PATHS = [".", "..", "../..", "../../..", "../../../..", "../../../../..", "../../../../../..", "../../../../../../.."];
const COMMIT_HASH_LEN = 7;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const getEnvValue = (key: string): string | undefined => {
  if (typeof Deno !== "undefined") {
    try {
      const value = Deno.env.get(key);
      if (value) {
        return value;
      }
    } catch {
      // ignore env access errors
    }
  }
  if (typeof process !== "undefined" && process.env) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
};

const readTextFile = async (path: string): Promise<string | null> => {
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
};

const toShortCommitHash = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || !COMMIT_HASH_RE.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_LEN);
};

const parseGitDirFromDotGitFile = (content: string): string | null => {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
  const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
  return match?.[1]?.trim() ?? null;
};

const isAbsolutePath = (path: string): boolean => path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);

const readGitHeadShortRevision = async (gitDir: string): Promise<string | null> => {
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
};

const runGitCommand = async (args: string): Promise<string | null> => {
  try {
    if (typeof Deno !== "undefined") {
      const command = new Deno.Command("git", { args: args.split(" ") });
      const { code, stdout } = await command.output();
      if (code === 0) {
        return new TextDecoder().decode(stdout).trim();
      }
    } else {
      // Node.js fallback
      const { execSync } = await import("child_process");
      return execSync(`git ${args}`, { encoding: "utf8" }).trim();
    }
  } catch {
    return null;
  }
  return null;
};

export async function getKernelCommit(): Promise<string> {
  const envHash = toShortCommitHash(getEnvValue("GIT_REVISION") ?? getEnvValue("GITHUB_SHA"));
  if (envHash) {
    return envHash;
  }

  try {
    const gitHash = await runGitCommand("rev-parse --short HEAD");
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
