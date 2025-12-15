type KernelAttestationPayload = Readonly<{
  iss: "ubiquity-os-kernel";
  aud: "ai.ubq.fi";
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

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(digest));
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
    iss: "ubiquity-os-kernel",
    aud: "ai.ubq.fi",
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
