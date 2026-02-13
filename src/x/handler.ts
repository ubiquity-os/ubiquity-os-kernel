import { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Env } from "../github/types/env.ts";
import { classifyTextIngress } from "../github/utils/reaction.ts";
import { logger as baseLogger } from "../logger/logger.ts";

const X_SIGNATURE_PREFIX = "sha256=";

type TwitterIngressConfig = {
  webhookSecret: string;
};

export async function handleTwitterWebhook(ctx: Context, env: Env): Promise<Response> {
  const logger = ctx.var.logger ?? baseLogger;
  const configResult = parseTwitterConfig(env);
  if (!configResult.ok) {
    return ctx.json({ error: configResult.error }, configResult.status);
  }
  const { webhookSecret } = configResult.config;

  if (ctx.req.method.toUpperCase() === "GET") {
    const crcToken = ctx.req.query("crc_token") ?? "";
    if (!crcToken) {
      return ctx.json({ error: "Missing crc_token." }, 400);
    }
    const responseToken = await signWebhook(webhookSecret, crcToken);
    return ctx.json({ response_token: `${X_SIGNATURE_PREFIX}${responseToken}` }, 200);
  }

  const bodyText = await ctx.req.text();
  const signatureHeader = ctx.req.header("x-twitter-webhooks-signature") ?? "";
  if (!signatureHeader) {
    return ctx.json({ error: "Missing signature." }, 401);
  }

  const expectedSignature = `${X_SIGNATURE_PREFIX}${await signWebhook(webhookSecret, bodyText)}`;
  if (signatureHeader !== expectedSignature) {
    return ctx.json({ error: "Unauthorized." }, 401);
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(bodyText) as Record<string, unknown>;
  } catch (error) {
    logger.warn({ err: error }, "Failed to parse X webhook payload");
  }

  const text = extractText(payload);
  if (text) {
    const reaction = classifyTextIngress(text);
    logger.info(
      {
        reaction: reaction.reaction,
        reflex: reaction.reflex,
      },
      "Classified X text ingress"
    );
  }

  logger.info(
    {
      hasPayload: Boolean(payload),
      keys: payload ? Object.keys(payload).slice(0, 8) : [],
    },
    "Received X webhook"
  );

  return ctx.json({}, 200);
}

async function signWebhook(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toBase64(new Uint8Array(signature));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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

function parseTwitterConfig(env: Env): { ok: true; config: TwitterIngressConfig } | { ok: false; status: ContentfulStatusCode; error: string } {
  const raw = normalizeOptionalEnvValue(env.UOS_X);
  if (!raw) {
    return { ok: false, status: 404, error: "X ingress disabled." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, status: 500, error: "Invalid UOS_X JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 500, error: "Invalid UOS_X config." };
  }
  const record = parsed as Record<string, unknown>;
  const webhookSecret = normalizeOptionalString(record.webhookSecret);
  if (!webhookSecret) {
    return { ok: false, status: 500, error: "UOS_X.webhookSecret is required." };
  }
  return { ok: true, config: { webhookSecret } };
}

function extractText(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const directMessages = payload.direct_message_events;
  if (Array.isArray(directMessages) && directMessages.length > 0) {
    const message = directMessages[0] as {
      message_create?: { message_data?: { text?: unknown } };
    };
    const text = message?.message_create?.message_data?.text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }

  const tweets = payload.tweet_create_events;
  if (Array.isArray(tweets) && tweets.length > 0) {
    const tweet = tweets[0] as { text?: unknown };
    const text = tweet?.text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }

  return null;
}
