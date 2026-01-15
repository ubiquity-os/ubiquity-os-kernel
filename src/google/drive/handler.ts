import { Context } from "hono";
import { Env } from "../../github/types/env.ts";
import { logger as baseLogger } from "../../logger/logger.ts";

type GoogleDriveIngressConfig = {
  webhookSecret: string;
};

export async function handleGoogleDriveWebhook(ctx: Context, env: Env): Promise<Response> {
  const logger = ctx.var.logger ?? baseLogger;
  const configResult = parseGoogleDriveConfig(env);
  if (!configResult.ok) {
    return ctx.json({ error: configResult.error }, configResult.status);
  }
  const { webhookSecret } = configResult.config;

  const token = ctx.req.header("x-goog-channel-token") ?? "";
  if (token !== webhookSecret) {
    return ctx.json({ error: "Unauthorized." }, 401);
  }

  const channelId = ctx.req.header("x-goog-channel-id") ?? "";
  const resourceId = ctx.req.header("x-goog-resource-id") ?? "";
  const resourceState = ctx.req.header("x-goog-resource-state") ?? "";
  const resourceUri = ctx.req.header("x-goog-resource-uri") ?? "";

  logger.info(
    {
      channelId,
      resourceId,
      resourceState,
      resourceUri,
    },
    "Received Google Drive webhook"
  );

  return ctx.json({ ok: true }, 200);
}

function normalizeOptionalEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseGoogleDriveConfig(env: Env): { ok: true; config: GoogleDriveIngressConfig } | { ok: false; status: number; error: string } {
  const raw = normalizeOptionalEnvValue(env.UOS_GOOGLE_DRIVE);
  if (!raw) {
    return { ok: false, status: 404, error: "Google Drive ingress disabled." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, status: 500, error: "Invalid UOS_GOOGLE_DRIVE JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 500, error: "Invalid UOS_GOOGLE_DRIVE config." };
  }
  const record = parsed as Record<string, unknown>;
  const webhookSecret = normalizeOptionalString(record.webhookSecret);
  if (!webhookSecret) {
    return { ok: false, status: 500, error: "UOS_GOOGLE_DRIVE.webhookSecret is required." };
  }
  return { ok: true, config: { webhookSecret } };
}
