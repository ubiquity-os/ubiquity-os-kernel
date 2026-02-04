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
import { getCachedRsaPublicKeyPem, normalizeMultilineSecret } from "./github/utils/rsa.ts";
import { listAgentMemoryEntries } from "./github/utils/agent-memory.ts";
import { logger } from "./logger/logger.ts";
import { signPayload } from "@ubiquity-os/plugin-sdk/signature";

const KERNEL_REFRESH_ROUTE = "/internal/agent/refresh-token";

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
    const diagnosticsToken = normalizeOptionalEnvValue(env.UOS_DIAGNOSTICS_TOKEN);
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

app.post(KERNEL_REFRESH_ROUTE, async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
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
    if (!isValidGitHubRepoSegment(owner) || !isValidGitHubRepoSegment(repo)) {
      return ctx.json({ error: "Invalid X-GitHub-Owner/X-GitHub-Repo." }, 400);
    }

    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return ctx.json({ error: "Invalid X-GitHub-Installation-Id." }, 400);
    }

    const privateKey = normalizeMultilineSecret(env.APP_PRIVATE_KEY);
    const publicKeyPem = await getCachedRsaPublicKeyPem(privateKey);
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

app.post("/", async (ctx: Context) => {
  try {
    const env = getEnvWithDefaults(ctx);
    const missingEnv: string[] = [];
    const aiBaseUrl = requireEnvValue(env.UOS_AI_BASE_URL, "UOS_AI_BASE_URL", missingEnv);
    const aiToken = normalizeOptionalEnvValue(env.UOS_AI_TOKEN);
    const agentOwner = requireEnvValue(env.UOS_AGENT_OWNER, "UOS_AGENT_OWNER", missingEnv);
    const agentRepo = requireEnvValue(env.UOS_AGENT_REPO, "UOS_AGENT_REPO", missingEnv);
    const agentWorkflow = requireEnvValue(env.UOS_AGENT_WORKFLOW, "UOS_AGENT_WORKFLOW", missingEnv);
    const agentRef = normalizeOptionalEnvValue(env.UOS_AGENT_REF);
    if (missingEnv.length > 0) {
      throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
    }
    const kernelRefreshIntervalSeconds = parseOptionalNumber(env.UOS_KERNEL_REFRESH_INTERVAL_SECONDS);
    const kernelRefreshUrl = resolveKernelRefreshUrl(ctx, env);
    const environment = env.ENVIRONMENT;
    const request = ctx.req;
    const eventName = getEventName(request);
    const signatureSha256 = getSignature(request);
    const id = getId(request);
    const eventHandler = new GitHubEventHandler({
      environment,
      webhookSecret: env.APP_WEBHOOK_SECRET,
      appId: env.APP_ID,
      privateKey: env.APP_PRIVATE_KEY,
      llm: "gpt-5.2-chat-latest",
      aiBaseUrl,
      aiToken,
      kernelRefreshUrl,
      kernelRefreshIntervalSeconds,
      agent: {
        owner: agentOwner,
        repo: agentRepo,
        workflowId: agentWorkflow,
        ref: agentRef,
      },
      logger: ctx.var.logger,
    });
    bindHandlers(eventHandler);

    const payload = await request.text();
    ctx.var.logger.debug(
      {
        eventName,
        id,
        signatureSha256Present: Boolean(signatureSha256),
        payloadLength: payload.length,
      },
      "Webhook received"
    );
    await eventHandler.webhooks.verifyAndReceive({ id, name: eventName, payload, signature: signatureSha256 });
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

function normalizeOptionalEnvValue(value?: string): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

function normalizeEnvList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function resolveKernelRefreshUrl(ctx: Context, env: Env): string {
  const baseUrl = normalizeOptionalEnvValue(env.UOS_KERNEL_BASE_URL);
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    return new URL(KERNEL_REFRESH_ROUTE, parsed).toString();
  }

  const trustedHosts = normalizeEnvList(env.UOS_KERNEL_TRUSTED_HOSTS);
  const requestUrl = new URL(ctx.req.url);
  if (trustedHosts.length > 0 && !trustedHosts.includes(requestUrl.host.toLowerCase())) {
    throw new Error(`Untrusted host for kernel refresh URL: ${requestUrl.host}`);
  }
  return new URL(KERNEL_REFRESH_ROUTE, requestUrl).toString();
}

function isValidGitHubRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function requireEnvValue(value: string | undefined, name: string, missing: string[]): string {
  const normalized = normalizeOptionalEnvValue(value) ?? "";
  if (!normalized) {
    missing.push(name);
  }
  return normalized;
}
