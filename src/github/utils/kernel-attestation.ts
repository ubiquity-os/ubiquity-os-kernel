const KERNEL_ATTESTATION_ISSUER = "ubiquity-os-kernel" as const;
const KERNEL_ATTESTATION_AUDIENCE = "ai.ubq.fi" as const;

export type KernelAttestationPayload = Readonly<{
  iss: typeof KERNEL_ATTESTATION_ISSUER;
  aud: typeof KERNEL_ATTESTATION_AUDIENCE;
  iat: number;
  exp: number;
  jti: string;
  owner: string;
  repo: string;
  installation_id: number | null;
  auth_token_sha256: string;
  state_id: string;
}>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return base64ToBase64Url(bytesToBase64(bytes));
}

function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlToBytes(raw: string): Uint8Array {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(raw: string): unknown {
  const bytes = base64UrlToBytes(raw);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

function parseKernelAttestationPayload(value: unknown): KernelAttestationPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const iss = typeof record.iss === "string" ? record.iss : "";
  const aud = typeof record.aud === "string" ? record.aud : "";
  const jti = typeof record.jti === "string" ? record.jti : "";
  const owner = typeof record.owner === "string" ? record.owner : "";
  const repo = typeof record.repo === "string" ? record.repo : "";
  const authTokenSha = typeof record.auth_token_sha256 === "string" ? record.auth_token_sha256 : "";
  const stateId = typeof record.state_id === "string" ? record.state_id : "";

  const iat = typeof record.iat === "number" && Number.isFinite(record.iat) ? Math.trunc(record.iat) : null;
  const exp = typeof record.exp === "number" && Number.isFinite(record.exp) ? Math.trunc(record.exp) : null;
  if (iat === null || exp === null) return null;

  const installationIdRaw = record.installation_id;
  let installationId: number | null = null;
  if (installationIdRaw === null) {
    installationId = null;
  } else if (typeof installationIdRaw === "number" && Number.isFinite(installationIdRaw)) {
    installationId = Math.trunc(installationIdRaw);
  }
  if (installationIdRaw !== null && installationId === null) return null;

  if (iss !== KERNEL_ATTESTATION_ISSUER) return null;
  if (aud !== KERNEL_ATTESTATION_AUDIENCE) return null;
  if (!jti || !owner || !repo || !authTokenSha || !stateId) return null;

  return {
    iss: KERNEL_ATTESTATION_ISSUER,
    aud: KERNEL_ATTESTATION_AUDIENCE,
    iat,
    exp,
    jti,
    owner,
    repo,
    installation_id: installationId,
    auth_token_sha256: authTokenSha,
    state_id: stateId,
  };
}

async function importRsaPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  const pemContents = publicKeyPem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").trim().replace(/\s+/g, "");
  const binary = atob(pemContents);
  const binaryDer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) binaryDer[i] = binary.charCodeAt(i);
  return await crypto.subtle.importKey("spki", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
}

const KERNEL_ATTESTATION_CLOCK_SKEW_SECONDS = 60;
const KERNEL_ATTESTATION_MAX_TTL_SECONDS = 60 * 60;

export async function verifyKernelAttestationToken(
  params: Readonly<{
    token: string;
    publicKeyPem: string;
    expected: Readonly<{
      owner: string;
      repo: string;
      installationId: number | null;
      authToken: string;
    }>;
    nowSeconds?: number;
  }>
): Promise<{ ok: true; payload: KernelAttestationPayload } | { ok: false; error: string }> {
  const token = params.token.trim();
  if (!token) return { ok: false, error: "Missing kernel attestation token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "Kernel attestation token format invalid" };

  let header: unknown;
  let payload: KernelAttestationPayload | null = null;

  try {
    header = base64UrlToJson(parts[0]);
    payload = parseKernelAttestationPayload(base64UrlToJson(parts[1]));
  } catch {
    return { ok: false, error: "Kernel attestation token decode failed" };
  }

  if (!header || typeof header !== "object" || (header as Record<string, unknown>).alg !== "RS256") {
    return { ok: false, error: "Kernel attestation header invalid" };
  }
  if (!payload) return { ok: false, error: "Kernel attestation payload invalid" };

  const now = typeof params.nowSeconds === "number" && Number.isFinite(params.nowSeconds) ? Math.trunc(params.nowSeconds) : Math.floor(Date.now() / 1000);
  if (payload.exp < payload.iat) return { ok: false, error: "Kernel attestation exp before iat" };
  if (payload.exp - payload.iat > KERNEL_ATTESTATION_MAX_TTL_SECONDS) {
    return { ok: false, error: "Kernel attestation TTL too long" };
  }
  if (payload.iat > now + KERNEL_ATTESTATION_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: "Kernel attestation not yet valid" };
  }
  if (payload.exp < now - KERNEL_ATTESTATION_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: "Kernel attestation expired" };
  }

  const expected = params.expected;
  if (payload.owner !== expected.owner || payload.repo !== expected.repo) {
    return { ok: false, error: "Kernel attestation repo mismatch" };
  }
  if (payload.installation_id !== expected.installationId) {
    return { ok: false, error: "Kernel attestation installation mismatch" };
  }

  const expectedTokenSha = await sha256Base64Url(expected.authToken);
  if (payload.auth_token_sha256 !== expectedTokenSha) {
    return { ok: false, error: "Kernel attestation token mismatch" };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(parts[2]);
  } catch {
    return { ok: false, error: "Kernel attestation signature decode failed" };
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const dataArray = new TextEncoder().encode(signingInput);
  const publicKey = await importRsaPublicKey(params.publicKeyPem);
  const isSignatureValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signatureBytes, dataArray);
  if (!isSignatureValid) return { ok: false, error: "Kernel attestation signature invalid" };

  return { ok: true, payload };
}

export async function createKernelAttestationToken(
  params: Readonly<{
    sign: (payload: string) => Promise<string>;
    owner: string;
    repo: string;
    installationId: number | null;
    authToken: string;
    stateId: string;
    ttlSeconds?: number;
  }>
): Promise<string> {
  const ttlSeconds = typeof params.ttlSeconds === "number" && Number.isFinite(params.ttlSeconds) ? Math.trunc(params.ttlSeconds) : 120;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload: KernelAttestationPayload = {
    iss: KERNEL_ATTESTATION_ISSUER,
    aud: KERNEL_ATTESTATION_AUDIENCE,
    iat: now,
    exp: now + Math.max(1, ttlSeconds),
    jti: crypto.randomUUID(),
    owner: params.owner,
    repo: params.repo,
    installation_id: params.installationId,
    auth_token_sha256: await sha256Base64Url(params.authToken),
    state_id: params.stateId,
  };

  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const signatureB64 = await params.sign(signingInput);
  if (typeof signatureB64 !== "string" || !signatureB64.trim()) {
    throw new Error("Kernel attestation signing failed: empty signature");
  }
  const signatureB64Url = base64ToBase64Url(signatureB64);
  return `${signingInput}.${signatureB64Url}`;
}
