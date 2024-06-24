import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Context } from "./context";
import { customOctokit } from "./octokit";
import { EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { verifySignature } from "./signature";
import { UBIQUIBOT_KERNEL_PUBLIC_KEY } from "./constants";

interface Options {
  ubiquibotKernelPublicKey?: string;
  logger?: {
    fatal?: (message: unknown, ...optionalParams: unknown[]) => void;
    error?: (message: unknown, ...optionalParams: unknown[]) => void;
    warn?: (message: unknown, ...optionalParams: unknown[]) => void;
    info?: (message: unknown, ...optionalParams: unknown[]) => void;
    debug?: (message: unknown, ...optionalParams: unknown[]) => void;
  };
}

export async function createPlugin<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName>(
  handler: (context: Context<TConfig, TEnv, TSupportedEvents>) => Promise<Record<string, unknown> | undefined>,
  options?: Options
) {
  const app = new Hono();

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
      logger: {
        fatal: options?.logger?.fatal || console.error,
        error: options?.logger?.error || console.error,
        warn: options?.logger?.warn || console.warn,
        info: options?.logger?.info || console.info,
        debug: options?.logger?.debug || console.debug,
      },
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
