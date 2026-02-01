import { emitterEventNames } from "@octokit/webhooks";
import { WebhookEventName } from "@octokit/webhooks-types";
import { Value } from "@sinclair/typebox/value";
import { Context, Hono, HonoRequest } from "hono";
import { env as honoEnv } from "hono/adapter";
import { requestId } from "hono/request-id";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { createAppAuth } from "@octokit/auth-app";
import { GitHubEventHandler } from "./github/github-event-handler.ts";
import { bindHandlers } from "./github/handlers/index.ts";
import { Env, envSchema } from "./github/types/env.ts";
import { createKernelAttestationToken, verifyKernelAttestationToken } from "./github/utils/kernel-attestation.ts";
import { getKernelCommit } from "./github/utils/kernel-metadata.ts";
import { deriveRsaPublicKeyPemFromPrivateKey } from "./github/utils/rsa.ts";
import { listAgentMemoryEntries } from "./github/utils/agent-memory.ts";
import { logger } from "./logger/logger.ts";
import { signPayload } from "@ubiquity-os/plugin-sdk/signature";
import { handleTelegramWebhook } from "./telegram/handler.ts";
import { handleGoogleDriveWebhook } from "./google/drive/handler.ts";
import { handleTwitterWebhook } from "./x/handler.ts";
import { parseGitHubAppConfig } from "./github/utils/github-app-config.ts";
import { parseAgentConfig, parseAiConfig, parseDiagnosticsConfig, parseKernelConfig } from "./github/utils/env-config.ts";

export const app = new Hono();
export default app;

app.use(requestId());
app.use(async (c: Context, next) => {
  const requestId = c.var.requestId;
  const childLogger = logger.child({ requestId });
  c.set("logger", childLogger);
  await next();
});

function getEnvWithDefaults(ctx: Context): Env {
  return Value.Decode(envSchema, Value.Default(envSchema, honoEnv(ctx))) as Env;
}

app.get("/", async (c) => {
  const commit = await getKernelCommit();
  return c.text(`Welcome to UbiquityOS kernel (${commit})`);
});

app.get("/internal/agent-memory", async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
    const diagnosticsConfig = parseDiagnosticsConfig(env.UOS_DIAGNOSTICS);
    if (!diagnosticsConfig.ok) {
      return ctx.json({ error: diagnosticsConfig.error }, 500);
    }
    const diagnosticsToken = diagnosticsConfig.config?.token;
    if (!diagnosticsToken) {
      return ctx.json({ error: "Diagnostics disabled." }, 404);
    }

    const authHeader = ctx.req.header("authorization") ?? "";
    const authToken = getBearerToken(authHeader);
    if (!authToken || authToken !== diagnosticsToken) {
      return ctx.json({ error: "Unauthorized." }, 401);
    }

    const owner = (ctx.req.query("owner") ?? "").trim();
    const repo = (ctx.req.query("repo") ?? "").trim();
    if (!owner || !repo) {
      return ctx.json({ error: "Missing owner or repo." }, 400);
    }

    const limit = parseBoundedInt(ctx.req.query("limit"), 25, 1, 200);
    const issueNumber = parseOptionalPositiveInt(ctx.req.query("issue"));
    const scopeKey = (ctx.req.query("scope") ?? "").trim() || undefined;

    const entries = await listAgentMemoryEntries({ owner, repo, limit, scopeKey });
    const filtered = issueNumber ? entries.filter((entry) => entry.issueNumber === issueNumber) : entries;

    return ctx.json({ entries: filtered, count: filtered.length }, 200);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/internal/agent/refresh-token", async (ctx: Context) => {
  try {
    const _env = getEnvWithDefaults(ctx);
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

    const privateKey = githubConfig.config.privateKey;
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

    const auth = createAppAuth({ appId: Number(githubConfig.config.appId), privateKey });
    const refreshed = await auth({ type: "installation", installationId });
    const refreshedKernelToken = await createKernelAttestationToken({
      sign: (payload) => signPayload(payload, privateKey),
      owner,
      repo,
      installationId,
      authToken: refreshed.token,
      stateId: verification.payload.state_id,
      ttlSeconds: 60 * 60,
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

app.post("/telegram", async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
    return await handleTelegramWebhook(ctx, env);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/google/drive", async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
    return await handleGoogleDriveWebhook(ctx, env);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.all("/x", async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
    return await handleTwitterWebhook(ctx, env);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/", async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
    const githubConfigResult = parseGitHubAppConfig(env);
    if (!githubConfigResult.ok) {
      if (githubConfigResult.error === "UOS_GITHUB is required.") {
        throw new Error("Missing required environment variables: UOS_GITHUB");
      }
      throw new Error(githubConfigResult.error);
    }
    const aiConfigResult = parseAiConfig(env.UOS_AI);
    if (!aiConfigResult.ok) {
      throw new Error(aiConfigResult.error);
    }
    const agentConfigResult = parseAgentConfig(env.UOS_AGENT);
    if (!agentConfigResult.ok) {
      throw new Error(agentConfigResult.error);
    }
    const kernelConfigResult = parseKernelConfig(env.UOS_KERNEL);
    if (!kernelConfigResult.ok) {
      throw new Error(kernelConfigResult.error);
    }
    const githubConfig = githubConfigResult.config;
    const aiConfig = aiConfigResult.config;
    const agentConfig = agentConfigResult.config;
    const kernelRefreshIntervalSeconds = kernelConfigResult.config.refreshIntervalSeconds;
    const kernelRefreshUrl = new URL("/internal/agent/refresh-token", ctx.req.url).toString();
    const request = ctx.req;
    const eventName = getEventName(request);
    const signatureSha256 = getSignature(request);
    const id = getId(request);
    const eventHandler = new GitHubEventHandler({
      environment: env.ENVIRONMENT,
      webhookSecret: githubConfig.webhookSecret,
      appId: githubConfig.appId,
      privateKey: githubConfig.privateKey,
      llm: "gpt-5.2-chat-latest",
      aiBaseUrl: aiConfig.baseUrl,
      aiToken: aiConfig.token,
      kernelRefreshUrl,
      kernelRefreshIntervalSeconds,
      agent: {
        owner: agentConfig.owner,
        repo: agentConfig.repo,
        workflowId: agentConfig.workflow,
        ref: agentConfig.ref,
      },
      logger: ctx.var.logger,
    });
    bindHandlers(eventHandler, env);

    await eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload: await request.text(), signature: signatureSha256 });
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

function parseOptionalPositiveInt(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function parseBoundedInt(value: string | null | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseOptionalPositiveInt(value);
  if (!parsed) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
