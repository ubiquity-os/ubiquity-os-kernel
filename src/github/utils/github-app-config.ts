import { Env } from "../types/env.ts";
import { normalizeMultilineSecret } from "./rsa.ts";

export type GitHubAppConfig = Readonly<{
  appId: string;
  webhookSecret: string;
  privateKey: string;
}>;

export function parseGitHubAppConfig(env: Env):
  | { ok: true; config: GitHubAppConfig }
  | {
      ok: false;
      error: string;
    } {
  const raw = env.UOS_GITHUB?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: "UOS_GITHUB is required." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "Invalid UOS_GITHUB JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Invalid UOS_GITHUB config." };
  }

  const record = parsed as Record<string, unknown>;
  const appId = normalizeOptionalId(record.appId);
  const webhookSecret = normalizeOptionalString(record.webhookSecret);
  const privateKey = normalizeOptionalString(record.privateKey);

  if (!appId) {
    return { ok: false, error: "UOS_GITHUB.appId is required." };
  }
  if (!webhookSecret) {
    return { ok: false, error: "UOS_GITHUB.webhookSecret is required." };
  }
  if (!privateKey) {
    return { ok: false, error: "UOS_GITHUB.privateKey is required." };
  }

  return {
    ok: true,
    config: {
      appId,
      webhookSecret,
      privateKey: normalizeMultilineSecret(privateKey),
    },
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? String(normalized) : undefined;
  }
  return normalizeOptionalString(value);
}
