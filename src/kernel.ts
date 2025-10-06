// src/kernel.ts

import { emitterEventNames } from "@octokit/webhooks";
import { WebhookEventName } from "@octokit/webhooks-types";
import { Value } from "@sinclair/typebox/value";
import { Context, Hono, HonoRequest } from "hono";
import { getRuntimeKey, env as honoEnv } from "hono/adapter";
import { requestId } from "hono/request-id";
import { ContentfulStatusCode } from "hono/utils/http-status";
import OpenAI from "openai";
import { AgentRegistry, createAgentJob } from "./agent/agent-registry";
import packageJson from "../package.json";
import { GitHubEventHandler } from "./github/github-event-handler";
import { bindHandlers } from "./github/handlers/index";
import { Env, envSchema } from "./github/types/env";
import { logger } from "./logger/logger";
import { AgentStateStore, EmptyStore } from "./github/utils/kv-store";
import { cors } from "hono/cors";
import { McpServer } from "./agent/mcp-server";
import { v4 as uuidv4 } from "uuid";

const sessionHeader = "'mcp-session-id'";

export const app = new Hono();

app.use(requestId());
app.use(async (c: Context, next) => {
  const requestId = c.var.requestId;
  const childLogger = logger.child({ requestId });
  c.set("logger", childLogger);
  await next();
});

// --- DEFINITIVE CORS MIDDLEWARE SETUP ---
// This handles the OPTIONS preflight request from the browser.
app.use(
  "*",
  cors({
    origin: "*", // In production, restrict this to your client's origin
    allowHeaders: [
      // Explicitly list all headers the client is allowed to send
      "Content-Type",
      "mcp-protocol-version",
      sessionHeader,
      "x-owner",
      "x-installation-id",
      "x-custom-auth-headers", // From your logs
      "x-mcp-proxy-auth", // From your logs
    ],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: [sessionHeader], // This is crucial for the client to read the session ID
  })
);

app.get("/", (c) => {
  return c.text(`Welcome to UbiquityOS kernel version ${packageJson.version}`);
});

// MCP Endpoint
app.post("/mcp", async (ctx: Context) => {
  try {
    const requestBody = (await ctx.req.json()) as {
      jsonrpc: "2.0";
      method: string;
      id: string;
      result?: Record<string, unknown>;
      error?: { code: number; message: string; data?: unknown };
    };
    const owner = ctx.req.header("x-owner");
    const installationIdHeader = ctx.req.header("x-installation-id");
    const sessionIdHeader = ctx.req.header("mcp-session-id");
    console.log("Headers : ", ctx.req.header());
    console.log("MCP Response: ", JSON.stringify(requestBody, null, 2));
    // FIXED: Parse the installationId to a number and validate it.
    const installationId = installationIdHeader ? parseInt(installationIdHeader, 10) : 0;

    if (requestBody.method !== "initialize" && (!owner || !installationId)) {
      return ctx.json(
        { jsonrpc: "2.0", id: requestBody.id, error: { code: -32602, message: "Missing or invalid 'x-owner' and/or 'x-installation-id' headers" } },
        400
      );
    }

    const agentStateStore = await AgentStateStore.create(ctx.env.KV_URL, ctx.var.logger);
    const agentRegistry = new AgentRegistry(agentStateStore);
    console.log(`MCP Request for owner: ${owner}, installationId: ${installationId}`);
    const mcpServer = new McpServer(ctx, agentRegistry);
    // Pass the correctly parsed, numeric installationId
    const response = await mcpServer.handleRequest(requestBody, owner, installationId);

    console.log("Request Body: ", requestBody);
    const sessionId = sessionIdHeader || uuidv4();
    ctx.res.headers.append("mcp-session-id", sessionId);
    console.log(`Set mcp-session-id header: ${sessionId}`);

    if (response instanceof Response) {
      return response;
    } else {
      return ctx.json(response);
    }
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

// Direct agent invocation endpoint
app.post("/agent", async (ctx: Context) => {
  try {
    const { agentId, capability, inputs, installationId, owner } = await ctx.req.json();
    const jobId = await createAgentJob(ctx, agentId, capability, inputs, owner, installationId);
    return ctx.json({ jobId });
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
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

app.get("/agent/job/:jobId", async (ctx: Context) => {
  try {
    const agentStateStore = await AgentStateStore.create(ctx.env.KV_URL, ctx.var.logger);
    const agentRegistry = new AgentRegistry(agentStateStore);
    const jobId = ctx.req.param("jobId");
    const jobState = await agentRegistry.getJobState(jobId);

    if (!jobState) {
      return ctx.json({ error: "Job not found" }, 404);
    }

    return ctx.json(jobState);
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/agent/response", async (ctx: Context) => {
  try {
    const { jobId, outputs } = await ctx.req.json();
    console.log("Agent response received for jobId:", jobId, "with outputs:", outputs);
    const agentStateStore = await AgentStateStore.create(ctx.env.KV_URL, ctx.var.logger);
    const agentRegistry = new AgentRegistry(agentStateStore);
    await agentRegistry.handleAgentResponse(jobId, outputs);

    return ctx.json({ success: true });
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/agent/error", async (ctx: Context) => {
  try {
    const agentStateStore = await AgentStateStore.create(ctx.env.KV_URL, ctx.var.logger);
    const agentRegistry = new AgentRegistry(agentStateStore);
    const { jobId, error } = await ctx.req.json();
    await agentRegistry.handleAgentError(jobId, error);
    return ctx.text("ok");
  } catch (error) {
    return handleUncaughtError(ctx, error);
  }
});

app.post("/", async (ctx: Context) => {
  try {
    const env = Value.Decode(envSchema, Value.Default(envSchema, honoEnv(ctx))) as Env;
    const request = ctx.req;
    const eventName = getEventName(request);
    const signatureSha256 = getSignature(request);
    const id = getId(request);
    const llmClient = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL,
    });
    const eventHandler = new GitHubEventHandler({
      environment: env.ENVIRONMENT,
      webhookSecret: env.APP_WEBHOOK_SECRET,
      appId: env.APP_ID,
      privateKey: env.APP_PRIVATE_KEY,
      pluginChainState: new EmptyStore(ctx.var.logger),
      llmClient,
      llm: env.OPENROUTER_MODEL,
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
