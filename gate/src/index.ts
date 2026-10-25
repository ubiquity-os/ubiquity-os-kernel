const CONFIG_PATH_RE =
  /^\.github\/\.ubiquity-os\.config(?:\.[a-z0-9_-]+)?\.ya?ml$/i;
const CACHE_ORIGIN = "https://gate-cache.internal";
const MEMORY_CACHE_TTL_MS = 30_000;
const ORG_VERSION_CACHE_TTL_MS = 60_000;
const REPO_STATUS_CACHE_TTL_MS = 5 * 60_000;
const encoder = new TextEncoder();

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

const memoryCache = new Map<string, CacheEntry>();

interface Env {
  APP_WEBHOOK_SECRET: string;
  CONFIG_STATUS: KVNamespace;
  ENVIRONMENT: string;
  KERNEL: Fetcher;
  KERNEL_URL: string;
}

type PushPayload = {
  head_commit?: CommitPayload;
  commits?: CommitPayload[];
  repository?: {
    full_name?: string;
    owner?: { login?: string };
    name?: string;
  };
};

type CommitPayload = {
  added?: string[];
  modified?: string[];
  removed?: string[];
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/") {
      return forwardRequest(request, env);
    }

    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    if (!(await verifySignature(env.APP_WEBHOOK_SECRET, body, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: PushPayload;
    try {
      payload = JSON.parse(body) as PushPayload;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const repository = readRepository(payload);
    if (!repository) {
      return new Response(null, { status: 204 });
    }

    const eventName = request.headers.get("x-github-event") ?? "";
    let orgVersion = await readOrgVersion(env, repository.owner);
    const isConfigChange = pushTouchesKernelConfig(payload);
    if (
      eventName === "push" &&
      repository.repo === ".ubiquity-os" &&
      isConfigChange
    ) {
      orgVersion += 1;
      await writeOrgVersion(env, repository.owner, orgVersion);
    }

    const repoKey = repoStatusKey(env, repository.fullName, orgVersion);
    let repoStatus = await readCache<"present" | "absent">(
      env,
      "repo-status",
      repoKey,
    );
    if (repoStatus !== "present" && repoStatus !== "absent") {
      repoStatus = (await env.CONFIG_STATUS.get(repoKey)) as
        | "present"
        | "absent"
        | null;
      if (repoStatus === "present" || repoStatus === "absent") {
        await writeCache(
          env,
          "repo-status",
          repoKey,
          repoStatus,
          REPO_STATUS_CACHE_TTL_MS,
        );
      }
    }
    if (repoStatus === "absent" && !isConfigChange) {
      return new Response(null, {
        status: 204,
        headers: { "x-uos-gate": "blocked" },
      });
    }

    const kernelRequest = new Request(
      `${env.KERNEL_URL.replace(/\/+$/, "")}/`,
      {
        method: "POST",
        headers: request.headers,
        body,
      },
    );
    const response = await env.KERNEL.fetch(kernelRequest);
    const configStatus = response.headers.get("x-uos-config");
    if (configStatus === "present" || configStatus === "absent") {
      try {
        await env.CONFIG_STATUS.put(repoKey, configStatus, {
          expirationTtl: 86_400,
        });
        await writeCache(
          env,
          "repo-status",
          repoKey,
          configStatus,
          REPO_STATUS_CACHE_TTL_MS,
        );
      } catch (error) {
        console.error("Failed to cache repository config status", {
          repo: repository.fullName,
          error,
        });
      }
    }
    return response;
  },
};

async function forwardRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const target = `${env.KERNEL_URL.replace(/\/+$/, "")}${url.pathname}${url.search}`;
  return env.KERNEL.fetch(new Request(target, request));
}

function readRepository(
  payload: PushPayload,
): { fullName: string; owner: string; repo: string } | null {
  const fullName =
    typeof payload.repository?.full_name === "string"
      ? payload.repository.full_name.trim()
      : "";
  if (!fullName || !fullName.includes("/")) return null;
  const [owner, repo] = fullName.toLowerCase().split("/", 2);
  if (!owner || !repo) return null;
  return { fullName: `${owner}/${repo}`, owner, repo };
}

function pushTouchesKernelConfig(payload: PushPayload): boolean {
  const commits = [...(payload.commits ?? [])];
  if (payload.head_commit) commits.push(payload.head_commit);
  return commits.some((commit) =>
    (["added", "modified", "removed"] as const).some((field) =>
      (commit?.[field] ?? []).some((path) => CONFIG_PATH_RE.test(path)),
    ),
  );
}

function cacheKey(env: Env, kind: string, id: string): string {
  return `${CACHE_ORIGIN}/${env.ENVIRONMENT}/${kind}/${encodeURIComponent(id)}`;
}

async function readCache<T>(
  env: Env,
  kind: string,
  id: string,
): Promise<T | null> {
  const key = cacheKey(env, kind, id);
  const now = Date.now();
  const local = memoryCache.get(key);
  if (local && local.expiresAt > now) return local.value as T;
  if (local) memoryCache.delete(key);

  try {
    const response = await caches.default.match(new Request(key));
    if (!response) return null;
    const entry = (await response.json()) as CacheEntry;
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now)
      return null;
    memoryCache.set(key, entry);
    return entry.value as T;
  } catch {
    return null;
  }
}

async function writeCache<T>(
  env: Env,
  kind: string,
  id: string,
  value: T,
  ttlMs: number,
): Promise<void> {
  const key = cacheKey(env, kind, id);
  const entry: CacheEntry = { value, expiresAt: Date.now() + ttlMs };
  memoryCache.set(key, {
    ...entry,
    expiresAt: Date.now() + Math.min(ttlMs, MEMORY_CACHE_TTL_MS),
  });
  try {
    await caches.default.put(
      new Request(key),
      new Response(JSON.stringify(entry), {
        headers: {
          "cache-control": `max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}`,
          "content-type": "application/json",
        },
      }),
    );
  } catch {
    // Cache API is an optimization; KV remains the durable source.
  }
}

function orgVersionKey(env: Env, owner: string): string {
  return `orgv:${env.ENVIRONMENT}:${owner}`;
}

async function readOrgVersion(env: Env, owner: string): Promise<number> {
  const cached = await readCache<number>(env, "org-version", owner);
  if (cached !== null) return cached;
  const raw = await env.CONFIG_STATUS.get(orgVersionKey(env, owner));
  const parsed = raw ? Number(raw) : 0;
  const version = Number.isFinite(parsed) ? parsed : 0;
  await writeCache(
    env,
    "org-version",
    owner,
    version,
    ORG_VERSION_CACHE_TTL_MS,
  );
  return version;
}

async function writeOrgVersion(
  env: Env,
  owner: string,
  version: number,
): Promise<void> {
  try {
    await env.CONFIG_STATUS.put(orgVersionKey(env, owner), String(version), {
      expirationTtl: 30 * 86_400,
    });
    await writeCache(
      env,
      "org-version",
      owner,
      version,
      ORG_VERSION_CACHE_TTL_MS,
    );
  } catch (error) {
    console.error("Failed to advance org config version", { owner, error });
  }
}

function repoStatusKey(
  env: Env,
  repositoryFullName: string,
  orgVersion: number,
): string {
  return `repo:${env.ENVIRONMENT}:${repositoryFullName}:${orgVersion}`;
}

async function verifySignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const value = signature.trim();
  if (!secret || !value.startsWith("sha256=")) return false;
  const signatureBytes = hexToBytes(value.slice("sha256=".length));
  if (!signatureBytes) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(body),
  );
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
