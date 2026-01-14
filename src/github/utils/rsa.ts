export function normalizeMultilineSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes("\n") && trimmed.includes("\\n")) {
    return trimmed.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  }
  return trimmed.replace(/\r\n/g, "\n");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function wrapPem(type: string, base64: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
}

export async function deriveRsaPublicKeyPemFromPrivateKey(privateKeyPem: string): Promise<string> {
  const pemContents = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .trim()
    .replace(/[\r\n\s]+/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey("pkcs8", binaryDer.buffer as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  if (!jwk.n || !jwk.e) {
    throw new Error("Unable to derive kernel public key: missing RSA modulus/exponent");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );

  const spkiDer = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return wrapPem("PUBLIC KEY", bytesToBase64(spkiDer));
}
