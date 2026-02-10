import type { KvKey, KvLike, LoggerLike } from "../github/utils/kv-client.ts";

export type TelegramRepoNotes = Readonly<{
  version: 1;
  owner: string;
  repo: string;
  createdAtMs: number;
  expiresAtMs: number;
  summary: string;
  inferred: Readonly<{
    runtime: string;
    evidence: string[];
    packageManagers: string[];
    ci: string[];
  }>;
  root: Readonly<{
    files: string[];
    dirs: string[];
    total: number;
    truncated: boolean;
  }>;
  languages: Record<string, number>;
}>;

const TELEGRAM_REPO_NOTES_PREFIX: KvKey = ["ubiquityos", "telegram", "repo-notes"];
const TELEGRAM_REPO_NOTES_TTL_MS = 24 * 60 * 60_000;
const TELEGRAM_REPO_NOTES_MAX_ROOT_ITEMS = 120;

const MARKER_DENO_JSON = "deno.json";
const MARKER_DENO_JSONC = "deno.jsonc";
const MARKER_DENO_LOCK = "deno.lock";
const MARKER_IMPORT_MAP_JSON = "import_map.json";

const MARKER_PACKAGE_JSON = "package.json";
const MARKER_PACKAGE_LOCK_JSON = "package-lock.json";
const MARKER_PNPM_LOCK_YAML = "pnpm-lock.yaml";
const MARKER_YARN_LOCK = "yarn.lock";

const MARKER_PYPROJECT_TOML = "pyproject.toml";
const MARKER_REQUIREMENTS_TXT = "requirements.txt";
const MARKER_PIPFILE = "pipfile";
const MARKER_SETUP_PY = "setup.py";

const MARKER_GO_MOD = "go.mod";
const MARKER_CARGO_TOML = "cargo.toml";
const MARKER_DOCKERFILE = "dockerfile";
const MARKER_DOCKER_COMPOSE_YML = "docker-compose.yml";
const MARKER_COMPOSE_YML = "compose.yml";
const MARKER_GITHUB_DIR = ".github";

const DENO_ROOT_MARKERS = [MARKER_DENO_JSON, MARKER_DENO_JSONC, MARKER_DENO_LOCK, MARKER_IMPORT_MAP_JSON] as const;
const NODE_ROOT_MARKERS = [MARKER_PACKAGE_JSON, MARKER_PACKAGE_LOCK_JSON, MARKER_PNPM_LOCK_YAML, MARKER_YARN_LOCK] as const;
const PYTHON_ROOT_MARKERS = [MARKER_PYPROJECT_TOML, MARKER_REQUIREMENTS_TXT, MARKER_PIPFILE, MARKER_SETUP_PY] as const;

type OctokitLike = Readonly<{
  rest: Readonly<{
    repos: Readonly<{
      getContent: (params: { owner: string; repo: string; path: string }) => Promise<{ data: unknown }>;
      listLanguages: (params: { owner: string; repo: string }) => Promise<{ data: unknown }>;
    }>;
  }>;
}>;

type RepoRootItem = Readonly<{
  name: string;
  type?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function buildTelegramRepoNotesKey(params: { owner: string; repo: string }): KvKey {
  const owner = normalizeKeyPart(params.owner);
  const repo = normalizeKeyPart(params.repo);
  return [...TELEGRAM_REPO_NOTES_PREFIX, "v1", owner, repo];
}

function parseTelegramRepoNotes(value: unknown): TelegramRepoNotes | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;

  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  const createdAtMs = typeof value.createdAtMs === "number" && Number.isFinite(value.createdAtMs) ? Math.trunc(value.createdAtMs) : 0;
  const expiresAtMs = typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs) ? Math.trunc(value.expiresAtMs) : 0;
  const summary = typeof value.summary === "string" ? value.summary : "";
  if (!owner || !repo || !createdAtMs || !expiresAtMs || !summary) return null;

  const inferredRaw = value.inferred;
  const inferred =
    isRecord(inferredRaw) && typeof inferredRaw.runtime === "string"
      ? {
          runtime: inferredRaw.runtime,
          evidence: Array.isArray(inferredRaw.evidence)
            ? inferredRaw.evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
            : [],
          packageManagers: Array.isArray(inferredRaw.packageManagers)
            ? inferredRaw.packageManagers.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
            : [],
          ci: Array.isArray(inferredRaw.ci)
            ? inferredRaw.ci.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
            : [],
        }
      : null;
  if (!inferred) return null;

  const rootRaw = value.root;
  const root =
    isRecord(rootRaw) && Array.isArray(rootRaw.files) && Array.isArray(rootRaw.dirs)
      ? {
          files: rootRaw.files.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()),
          dirs: rootRaw.dirs.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()),
          total: typeof rootRaw.total === "number" && Number.isFinite(rootRaw.total) ? Math.trunc(rootRaw.total) : 0,
          truncated: Boolean(rootRaw.truncated),
        }
      : null;
  if (!root) return null;

  const languagesRaw = value.languages;
  const languages: Record<string, number> = {};
  if (isRecord(languagesRaw)) {
    for (const [key, raw] of Object.entries(languagesRaw)) {
      if (typeof key !== "string" || !key.trim()) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      languages[key] = raw;
    }
  }

  return {
    version: 1,
    owner,
    repo,
    createdAtMs,
    expiresAtMs,
    summary,
    inferred,
    root,
    languages,
  };
}

function splitRootItems(items: RepoRootItem[]): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const type = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
    if (type === "dir") {
      dirs.push(name);
    } else {
      files.push(name);
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  dirs.sort((a, b) => a.localeCompare(b));
  return { files, dirs };
}

function inferRuntimeFromRoot(params: { files: string[]; dirs: string[]; languages: Record<string, number> }) {
  const fileSet = new Set(params.files.map((name) => name.toLowerCase()));
  const dirSet = new Set(params.dirs.map((name) => name.toLowerCase()));

  const evidence: string[] = [];
  const packageManagers: string[] = [];
  const ci: string[] = [];

  const hasDeno = DENO_ROOT_MARKERS.some((marker) => fileSet.has(marker));
  const hasNode = NODE_ROOT_MARKERS.some((marker) => fileSet.has(marker));
  const hasPython = PYTHON_ROOT_MARKERS.some((marker) => fileSet.has(marker));
  const hasGo = fileSet.has(MARKER_GO_MOD);
  const hasRust = fileSet.has(MARKER_CARGO_TOML);

  const hasGithubDir = dirSet.has(MARKER_GITHUB_DIR);
  const hasDocker = fileSet.has(MARKER_DOCKERFILE) || fileSet.has(MARKER_DOCKER_COMPOSE_YML) || fileSet.has(MARKER_COMPOSE_YML);

  if (hasGithubDir) ci.push("github-actions");
  if (hasDocker) ci.push("docker");

  let runtime = "unknown";
  if (hasDeno) {
    runtime = "deno";
    for (const marker of DENO_ROOT_MARKERS) {
      if (fileSet.has(marker)) evidence.push(marker);
    }
    packageManagers.push("deno");
  } else if (hasNode) {
    runtime = "node";
    if (fileSet.has(MARKER_PACKAGE_JSON)) evidence.push(MARKER_PACKAGE_JSON);
    if (fileSet.has(MARKER_PNPM_LOCK_YAML)) packageManagers.push("pnpm");
    if (fileSet.has(MARKER_YARN_LOCK)) packageManagers.push("yarn");
    if (fileSet.has(MARKER_PACKAGE_LOCK_JSON)) packageManagers.push("npm");
    if (packageManagers.length === 0) packageManagers.push("node");
  } else if (hasPython) {
    runtime = "python";
    if (fileSet.has(MARKER_PYPROJECT_TOML)) evidence.push(MARKER_PYPROJECT_TOML);
    if (fileSet.has(MARKER_REQUIREMENTS_TXT)) evidence.push(MARKER_REQUIREMENTS_TXT);
    if (fileSet.has(MARKER_PIPFILE)) evidence.push("Pipfile");
    if (fileSet.has(MARKER_SETUP_PY)) evidence.push(MARKER_SETUP_PY);
  } else if (hasGo) {
    runtime = "go";
    evidence.push(MARKER_GO_MOD);
  } else if (hasRust) {
    runtime = "rust";
    evidence.push(MARKER_CARGO_TOML);
  } else {
    const languageKeys = Object.keys(params.languages ?? {});
    if (languageKeys.includes("TypeScript") || languageKeys.includes("JavaScript")) {
      runtime = "javascript";
    } else if (languageKeys.includes("Python")) {
      runtime = "python";
    }
  }

  return { runtime, evidence, packageManagers, ci };
}

function formatRepoNotesSummary(params: {
  owner: string;
  repo: string;
  inferred: ReturnType<typeof inferRuntimeFromRoot>;
  root: { files: string[]; dirs: string[]; total: number; truncated: boolean };
  languages: Record<string, number>;
}): string {
  const lines: string[] = [];
  const { runtime, evidence, packageManagers, ci } = params.inferred;
  const evidenceText = evidence.length ? ` (evidence: ${evidence.join(", ")})` : "";
  lines.push(`Repo: ${params.owner}/${params.repo}`);
  lines.push(`Runtime: ${runtime}${evidenceText}`);
  if (packageManagers.length) lines.push(`Package managers: ${[...new Set(packageManagers)].join(", ")}`);
  if (ci.length) lines.push(`CI/ops hints: ${[...new Set(ci)].join(", ")}`);

  const languageNames = Object.keys(params.languages ?? {});
  if (languageNames.length) {
    languageNames.sort((a, b) => a.localeCompare(b));
    lines.push(`Languages: ${languageNames.join(", ")}`);
  }

  const sampleFiles = params.root.files.slice(0, 20);
  const sampleDirs = params.root.dirs.slice(0, 12);
  const rootLines: string[] = [];
  if (sampleDirs.length) rootLines.push(`dirs: ${sampleDirs.join(", ")}`);
  if (sampleFiles.length) rootLines.push(`files: ${sampleFiles.join(", ")}`);
  if (rootLines.length) {
    lines.push(`Repo root${params.root.truncated ? " (partial)" : ""}: ${rootLines.join(" | ")}`);
  }

  return lines.join("\n").trim();
}

async function fetchRepoRoot(octokit: OctokitLike, owner: string, repo: string, logger?: LoggerLike): Promise<RepoRootItem[]> {
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path: "" });
    const data = (response as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data
        .map((item) => {
          if (!isRecord(item)) return null;
          const name = typeof item.name === "string" ? item.name.trim() : "";
          const type = typeof item.type === "string" ? item.type.trim() : undefined;
          if (!name) return null;
          return { name, ...(type ? { type } : {}) } as RepoRootItem;
        })
        .filter((item): item is RepoRootItem => Boolean(item));
    }
    // Empty repos and other edge cases can return a single object. Treat as "unknown root".
    return [];
  } catch (error) {
    logger?.debug?.({ err: error, owner, repo }, "Failed to fetch repo root (non-fatal)");
    return [];
  }
}

async function fetchRepoLanguages(octokit: OctokitLike, owner: string, repo: string, logger?: LoggerLike): Promise<Record<string, number>> {
  try {
    const response = await octokit.rest.repos.listLanguages({ owner, repo });
    const data = (response as { data?: unknown }).data;
    if (!isRecord(data)) return {};
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(data)) {
      if (typeof key !== "string" || !key.trim()) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      out[key] = raw;
    }
    return out;
  } catch (error) {
    logger?.debug?.({ err: error, owner, repo }, "Failed to fetch repo languages (non-fatal)");
    return {};
  }
}

export async function getOrBuildTelegramRepoNotes(params: {
  kv: KvLike;
  octokit: OctokitLike;
  owner: string;
  repo: string;
  nowMs?: number;
  logger?: LoggerLike;
}): Promise<TelegramRepoNotes | null> {
  const owner = params.owner.trim();
  const repo = params.repo.trim();
  if (!owner || !repo) return null;

  const key = buildTelegramRepoNotesKey({ owner, repo });
  const nowMs = typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? Math.trunc(params.nowMs) : Date.now();

  try {
    const existing = await params.kv.get(key);
    const parsed = parseTelegramRepoNotes(existing.value);
    if (parsed && parsed.expiresAtMs > nowMs) {
      return parsed;
    }
  } catch (error) {
    params.logger?.debug?.({ err: error, owner, repo }, "Failed to load cached Telegram repo notes (non-fatal)");
  }

  const rootItems = await fetchRepoRoot(params.octokit, owner, repo, params.logger);
  const languages = await fetchRepoLanguages(params.octokit, owner, repo, params.logger);
  const rootTotal = rootItems.length;
  const isTruncated = rootTotal > TELEGRAM_REPO_NOTES_MAX_ROOT_ITEMS;
  const limitedItems = isTruncated ? rootItems.slice(0, TELEGRAM_REPO_NOTES_MAX_ROOT_ITEMS) : rootItems;
  const split = splitRootItems(limitedItems);
  const inferred = inferRuntimeFromRoot({ ...split, languages });
  const createdAtMs = nowMs;
  const expiresAtMs = nowMs + TELEGRAM_REPO_NOTES_TTL_MS;
  const summary = formatRepoNotesSummary({
    owner,
    repo,
    inferred,
    root: { ...split, total: rootTotal, truncated: isTruncated },
    languages,
  });

  const record: TelegramRepoNotes = {
    version: 1,
    owner,
    repo,
    createdAtMs,
    expiresAtMs,
    summary,
    inferred,
    root: { ...split, total: rootTotal, truncated: isTruncated },
    languages,
  };

  try {
    await params.kv.set(key, record, { expireIn: TELEGRAM_REPO_NOTES_TTL_MS });
  } catch (error) {
    params.logger?.debug?.({ err: error, owner, repo }, "Failed to persist Telegram repo notes (non-fatal)");
  }

  return record;
}
