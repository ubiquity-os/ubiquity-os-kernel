const NEGATIVE_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 1_000;
const CONFIG_PATH_RE = /^\.github\/\.ubiquity-os\.config(?:\.[a-z0-9_-]+)?\.ya?ml$/i;

const unconfiguredRepositories = new Map<string, number>();
const configuredRepositories = new Map<string, true>();

function normalizeRepositoryFullName(value: string): string {
  return value.trim().toLowerCase();
}

function cacheKey(environment: string, repositoryFullName: string): string {
  return `${environment.trim().toLowerCase()}:${normalizeRepositoryFullName(repositoryFullName)}`;
}

function pruneExpired(now: number): void {
  for (const [key, expiresAt] of unconfiguredRepositories) {
    if (expiresAt <= now) {
      unconfiguredRepositories.delete(key);
    }
  }
  while (unconfiguredRepositories.size > MAX_CACHE_ENTRIES) {
    const oldest = unconfiguredRepositories.keys().next().value;
    if (!oldest) break;
    unconfiguredRepositories.delete(oldest);
  }
  while (configuredRepositories.size > MAX_CACHE_ENTRIES) {
    const oldest = configuredRepositories.keys().next().value;
    if (!oldest) break;
    configuredRepositories.delete(oldest);
  }
}

export function extractRepositoryFullName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("repository" in payload)) {
    return null;
  }
  const repository = (payload as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") {
    return null;
  }
  const fullName = (repository as { full_name?: unknown }).full_name;
  if (typeof fullName === "string" && fullName.trim()) {
    return normalizeRepositoryFullName(fullName);
  }
  const owner = (repository as { owner?: { login?: unknown } }).owner?.login;
  const name = (repository as { name?: unknown }).name;
  if (typeof owner === "string" && owner.trim() && typeof name === "string" && name.trim()) {
    return normalizeRepositoryFullName(`${owner}/${name}`);
  }
  return null;
}

export function isRepositoryKnownUnconfigured(environment: string, repositoryFullName: string, now = Date.now()): boolean {
  pruneExpired(now);
  const expiresAt = unconfiguredRepositories.get(cacheKey(environment, repositoryFullName));
  return typeof expiresAt === "number" && expiresAt > now;
}

export function markRepositoryUnconfigured(environment: string, repositoryFullName: string, now = Date.now()): void {
  pruneExpired(now);
  const key = cacheKey(environment, repositoryFullName);
  configuredRepositories.delete(key);
  unconfiguredRepositories.set(key, now + NEGATIVE_CACHE_TTL_MS);
}

export function markRepositoryConfigured(environment: string, repositoryFullName: string): void {
  const key = cacheKey(environment, repositoryFullName);
  unconfiguredRepositories.delete(key);
  configuredRepositories.set(key, true);
}

export function getRepositoryConfigStatus(environment: string, repositoryFullName: string, now = Date.now()): "present" | "absent" | null {
  pruneExpired(now);
  const key = cacheKey(environment, repositoryFullName);
  if (configuredRepositories.has(key)) return "present";
  const expiresAt = unconfiguredRepositories.get(key);
  if (typeof expiresAt === "number" && expiresAt > now) return "absent";
  return null;
}

export function pushTouchesKernelConfig(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const payloadRecord = payload as { commits?: unknown; head_commit?: unknown };
  const commits = Array.isArray(payloadRecord.commits) ? [...payloadRecord.commits] : [];
  if (payloadRecord.head_commit) {
    commits.push(payloadRecord.head_commit);
  }
  if (!commits.length) return false;
  for (const commit of commits) {
    if (!commit || typeof commit !== "object") continue;
    for (const field of ["added", "modified", "removed"] as const) {
      const paths = (commit as Record<string, unknown>)[field];
      if (!Array.isArray(paths)) continue;
      if (paths.some((path) => typeof path === "string" && CONFIG_PATH_RE.test(path))) {
        return true;
      }
    }
  }
  return false;
}

export function shouldSkipUnconfiguredRepository(environment: string, eventName: string, payload: unknown): boolean {
  const repository = extractRepositoryFullName(payload);
  if (!repository) return false;

  if (eventName === "push" && pushTouchesKernelConfig(payload)) {
    if (repository.endsWith("/.ubiquity-os")) {
      resetRepositoryConfigCache();
    } else {
      markRepositoryConfigured(environment, repository);
    }
    return false;
  }

  return isRepositoryKnownUnconfigured(environment, repository);
}

export function resetRepositoryConfigCache(): void {
  unconfiguredRepositories.clear();
  configuredRepositories.clear();
}
