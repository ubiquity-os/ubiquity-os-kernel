import { emitterEventNames } from "@octokit/webhooks";
import { WebhookEventName } from "@octokit/webhooks-types";
import { Value } from "@sinclair/typebox/value";
import { Context, Hono, HonoRequest } from "hono";
import { getRuntimeKey, env as honoEnv } from "hono/adapter";
import { requestId } from "hono/request-id";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { createAppAuth } from "@octokit/auth-app";
import OpenAI from "openai";
import packageJson from "../package.json" with { type: "json" };
import { GitHubEventHandler } from "./github/github-event-handler.ts";
import { bindHandlers } from "./github/handlers/index.ts";
import { Env, envSchema } from "./github/types/env.ts";
import { createKernelAttestationToken, verifyKernelAttestationToken } from "./github/utils/kernel-attestation.ts";
import { deriveRsaPublicKeyPemFromPrivateKey, normalizeMultilineSecret } from "./github/utils/rsa.ts";
import { logger } from "./logger/logger.ts";
import { signPayload } from "@ubiquity-os/plugin-sdk/signature";

export const app = new Hono();

app.use(requestId());
app.use(async (c: Context, next) => {
  const requestId = c.var.requestId;
  const childLogger = logger.child({ requestId });
  c.set("logger", childLogger);
  await next();
});

app.get("/", (c) => {
  return c.text(`Welcome to UbiquityOS kernel version ${packageJson.version}`);
});

app.get("/x25519_public_key", async (ctx: Context) => {
  if (!ctx.env.X25519_PRIVATE_KEY) {
    return ctx.text("No key available", 500);
  }
  const sodium = await import("libsodium-wrappers"); // we have to import dynamically: https://github.com/jedisct1/libsodium/pull/1401
  await sodium.ready;
  const binaryPrivate = sodium.from_base64(ctx.env.X25519_PRIVATE_KEY, sodium.base64_variants.URLSAFE_NO_PADDING);
  return ctx.text(sodium.default.crypto_scalarmult_base(binaryPrivate, "base64"));
});

app.post("/internal/agent/refresh-token", async (ctx: Context) => {
  try {
    const env = Value.Decode(envSchema, Value.Default(envSchema, honoEnv(ctx))) as Env;
    const authHeader = ctx.req.header("authorization") ?? "";
    const authToken = getBearerToken(authHeader);
    if (!authToken) {
      return ctx.json({ error: "Missing Authorization bearer token." }, 401);
    }
    if (!authToken.startsWith("gh")) {
      return ctx.json({ error: "GitHub installation token required." }, 400);
    }

    const kernelToken = (ctx.req.header("x-ubiquity-kernel-token") ?? "").trim();
    if (!kernelToken) {
      return ctx.json({ error: "Missing X-Ubiquity-Kernel-Token." }, 401);
    }

    const owner = (ctx.req.header("x-github-owner") ?? "").trim();
    const repo = (ctx.req.header("x-github-repo") ?? "").trim();
    const installationIdRaw = (ctx.req.header("x-github-installation-id") ?? "").trim();
    if (!owner || !repo || !installationIdRaw) {
      return ctx.json({ error: "Missing X-GitHub-Owner/X-GitHub-Repo/X-GitHub-Installation-Id." }, 400);
    }

    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId)) {
      return ctx.json({ error: "Invalid X-GitHub-Installation-Id." }, 400);
    }

    const privateKey = normalizeMultilineSecret(env.APP_PRIVATE_KEY);
    const publicKeyPem = await deriveRsaPublicKeyPemFromPrivateKey(privateKey);
    const verification = await verifyKernelAttestationToken({
      token: kernelToken,
      publicKeyPem,
      expected: {
        owner,
        repo,
        installationId,
        authToken,
      },
    });
    if (!verification.ok) {
      return ctx.json({ error: verification.error }, 401);
    }

    const auth = createAppAuth({ appId: Number(env.APP_ID), privateKey });
    const refreshed = await auth({ type: "installation", installationId });
    const refreshedKernelToken = await createKernelAttestationToken({
      sign: (payload) => signPayload(payload, privateKey),
      owner,
      repo,
      installationId,
      authToken: refreshed.token,
      stateId: verification.payload.state_id,
      ttlSeconds: 10 * 60,
    });

    return ctx.json({
      authToken: refreshed.token,
      ubiquityKernelToken: refreshedKernelToken,
      expiresAt: "expiresAt" in refreshed ? refreshed.expiresAt : null,
    });
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/", async (ctx: Context) => {
  try {
    const env = Value.Decode(envSchema, Value.Default(envSchema, honoEnv(ctx))) as Env;
    const kernelRefreshIntervalSeconds = parseOptionalNumber(env.UOS_KERNEL_REFRESH_INTERVAL_SECONDS);
    const kernelRefreshUrl = new URL("/internal/agent/refresh-token", ctx.req.url).toString();
    const request = ctx.req;
    const eventName = getEventName(request);
    const signatureSha256 = getSignature(request);
    const id = getId(request);
    const llmClient = new OpenAI({ apiKey: "dummy" });
    const eventHandler = new GitHubEventHandler({
      environment: env.ENVIRONMENT,
      webhookSecret: env.APP_WEBHOOK_SECRET,
      appId: env.APP_ID,
      privateKey: env.APP_PRIVATE_KEY,
      llmClient,
      llm: "gpt-5.2",
      aiBaseUrl: env.UOS_AI_BASE_URL,
      kernelRefreshUrl,
      kernelRefreshIntervalSeconds,
      agent: {
        owner: env.UOS_AGENT_OWNER,
        repo: env.UOS_AGENT_REPO,
        workflowId: env.UOS_AGENT_WORKFLOW,
        ref: env.UOS_AGENT_REF,
      },
      logger: ctx.var.logger,
    });
    bindHandlers(eventHandler);

    // if running in Cloudflare Worker, handle the webhook in the background and return a response immediately
    if (getRuntimeKey() === "workerd") {
      ctx.executionCtx.waitUntil(eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload: await request.text(), signature: signatureSha256 }));
    } else {
      await eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload: await request.text(), signature: signatureSha256 });
    }
    return ctx.text("ok\n", 200);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

function handleUncaughtError(ctx: Context, error: unknown) {
  ctx.var.logger.error(error, "Uncaught error");
  let status = 500;
  let errorMessage = "An uncaught error occurred";
  if (error instanceof AggregateError) {
    const err = error.errors[0];
    errorMessage = err.message ? `${err.name}: ${err.message}` : `Error: ${errorMessage}`;
    status = typeof err.status !== "undefined" && typeof err.status === "number" ? err.status : 500;
  } else {
    errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${error}`;
  }
  return ctx.json({ error: errorMessage }, status as ContentfulStatusCode);
}

function getBearerToken(authHeader: string): string {
  const trimmed = authHeader.trim();
  if (!trimmed) return "";
  const match = /^Bearer\s+(.+)$/iu.exec(trimmed);
  return match ? match[1].trim() : "";
}

function getEventName(request: HonoRequest): WebhookEventName {
  const eventName = request.header("x-github-event");
  if (!eventName || !emitterEventNames.includes(eventName as WebhookEventName)) {
    throw new Error(`Unsupported or missing "x-github-event" header value: ${eventName}`);
  }
  return eventName as WebhookEventName;
}

function getSignature(request: HonoRequest): string {
  const signatureSha256 = request.header("x-hub-signature-256");
  if (!signatureSha256) {
    throw new Error(`Missing "x-hub-signature-256" header`);
  }
  return signatureSha256;
}

function getId(request: HonoRequest): string {
  const id = request.header("x-github-delivery");
  if (!id) {
    throw new Error(`Missing "x-github-delivery" header`);
  }
  return id;
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}
