const CONFIG_PATH_RE = /^\.github\/\.ubiquity-os\.config(?:\.[a-z0-9_-]+)?\.ya?ml$/i;
const encoder = new TextEncoder();

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
  repository?: { full_name?: string; owner?: { login?: string }; name?: string };
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
    if (eventName === "push" && repository.repo === ".ubiquity-os" && isConfigChange) {
      orgVersion += 1;
      await writeOrgVersion(env, repository.owner, orgVersion);
    }

    const repoKey = repoStatusKey(env, repository.fullName, orgVersion);
    const cached = await env.CONFIG_STATUS.get(repoKey);
    if (cached === "absent" && !isConfigChange) {
      return new Response(null, { status: 204, headers: { "x-uos-gate": "blocked" } });
    }

    const kernelRequest = new Request(`${env.KERNEL_URL.replace(/\/+$/, "")}/`, {
      method: "POST",
      headers: request.headers,
      body,
    });
    const response = await env.KERNEL.fetch(kernelRequest);
    const configStatus = response.headers.get("x-uos-config");
    if (configStatus === "present" || configStatus === "absent") {
      try {
        await env.CONFIG_STATUS.put(repoKey, configStatus, { expirationTtl: 86_400 });
      } catch (error) {
        console.error("Failed to cache repository config status", { repo: repository.fullName, error });
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

function readRepository(payload: PushPayload): { fullName: string; owner: string; repo: string } | null {
  const fullName = typeof payload.repository?.full_name === "string" ? payload.repository.full_name.trim() : "";
  if (!fullName || !fullName.includes("/")) return null;
  const [owner, repo] = fullName.toLowerCase().split("/", 2);
  if (!owner || !repo) return null;
  return { fullName: `${owner}/${repo}`, owner, repo };
}

function pushTouchesKernelConfig(payload: PushPayload): boolean {
  const commits = [...(payload.commits ?? [])];
  if (payload.head_commit) commits.push(payload.head_commit);
  return commits.some((commit) =>
    (["added", "modified", "removed"] as const).some((field) => (commit?.[field] ?? []).some((path) => CONFIG_PATH_RE.test(path)))
  );
}

function orgVersionKey(env: Env, owner: string): string {
  return `orgv:${env.ENVIRONMENT}:${owner}`;
}

async function readOrgVersion(env: Env, owner: string): Promise<number> {
  const raw = await env.CONFIG_STATUS.get(orgVersionKey(env, owner));
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function writeOrgVersion(env: Env, owner: string, version: number): Promise<void> {
  try {
    await env.CONFIG_STATUS.put(orgVersionKey(env, owner), String(version), { expirationTtl: 30 * 86_400 });
  } catch (error) {
    console.error("Failed to advance org config version", { owner, error });
  }
}

function repoStatusKey(env: Env, repositoryFullName: string, orgVersion: number): string {
  return `repo:${env.ENVIRONMENT}:${repositoryFullName}:${orgVersion}`;
}

async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const value = signature.trim();
  if (!secret || !value.startsWith("sha256=")) return false;
  const signatureBytes = hexToBytes(value.slice("sha256=".length));
  if (!signatureBytes) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body));
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
