import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Context } from "./context";
import { customOctokit } from "./octokit";
import { EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { verifySignature } from "./signature";
import { UBIQUIBOT_KERNEL_PUBLIC_KEY } from "./constants";
import { Logs, LogLevel, LOG_LEVEL } from "@ubiquity-dao/ubiquibot-logger";
import { Manifest } from "../types/manifest";

interface Options {
  ubiquibotKernelPublicKey?: string;
  logLevel?: LogLevel;
}

export async function createPlugin<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName>(
  handler: (context: Context<TConfig, TEnv, TSupportedEvents>) => Promise<Record<string, unknown> | undefined>,
  manifest: Manifest,
  options?: Options
) {
  const app = new Hono();

  app.get("/manifest.json", (ctx) => {
    return ctx.json(manifest);
  });

  app.post("/", async (ctx) => {
    if (ctx.req.header("content-type") !== "application/json") {
      throw new HTTPException(400, { message: "Content-Type must be application/json" });
    }

    const payload = await ctx.req.json();
    const signature = payload.signature;
    delete payload.signature;
    if (!(await verifySignature(options?.ubiquibotKernelPublicKey || UBIQUIBOT_KERNEL_PUBLIC_KEY, payload, signature))) {
      throw new HTTPException(400, { message: "Invalid signature" });
    }

    try {
      new customOctokit({ auth: payload.authToken });
    } catch (error) {
      console.error("SDK ERROR", error);
      throw new HTTPException(500, { message: "Unexpected error" });
    }

    const context: Context<TConfig, TEnv, TSupportedEvents> = {
      eventName: payload.eventName,
      payload: payload.payload,
      octokit: new customOctokit({ auth: payload.authToken }),
      config: payload.settings as TConfig,
      env: ctx.env as TEnv,
      logger: new Logs(options?.logLevel || LOG_LEVEL.INFO),
    };

    try {
      const result = await handler(context);
      return ctx.json({ stateId: payload.stateId, output: result });
    } catch (error) {
      console.error(error);
      throw new HTTPException(500, { message: "Unexpected error" });
    }
  });

  return app;
}
