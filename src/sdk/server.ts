import { EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { TAnySchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { LOG_LEVEL, LogLevel, LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Manifest } from "../types/manifest";
import { KERNEL_PUBLIC_KEY } from "./constants";
import { Context } from "./context";
import { customOctokit } from "./octokit";
import { verifySignature } from "./signature";
import { sanitizeMetadata } from "./util";

interface Options {
  kernelPublicKey?: string;
  logLevel?: LogLevel;
  postCommentOnError?: boolean;
  settingsSchema?: TAnySchema;
  envSchema?: TAnySchema;
}

export async function createPlugin<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName>(
  handler: (context: Context<TConfig, TEnv, TSupportedEvents>) => Promise<Record<string, unknown> | undefined>,
  manifest: Manifest,
  options?: Options
) {
  const pluginOptions = {
    kernelPublicKey: options?.kernelPublicKey || KERNEL_PUBLIC_KEY,
    logLevel: options?.logLevel || LOG_LEVEL.INFO,
    postCommentOnError: options?.postCommentOnError || true,
    settingsSchema: options?.settingsSchema,
    envSchema: options?.envSchema,
  };

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
    if (!(await verifySignature(pluginOptions.kernelPublicKey, payload, signature))) {
      throw new HTTPException(400, { message: "Invalid signature" });
    }

    let config: TConfig;
    if (pluginOptions.settingsSchema) {
      config = Value.Decode(pluginOptions.settingsSchema, payload.settings);
    } else {
      config = payload.settings as TConfig;
    }

    let env: TEnv;
    if (pluginOptions.envSchema) {
      env = Value.Decode(pluginOptions.envSchema, process.env);
    } else {
      env = process.env as TEnv;
    }

    const context: Context<TConfig, TEnv, TSupportedEvents> = {
      eventName: payload.eventName,
      payload: payload.eventPayload,
      octokit: new customOctokit({ auth: payload.authToken }),
      config: config,
      env: env,
      logger: new Logs(pluginOptions.logLevel),
    };

    try {
      const result = await handler(context);
      return ctx.json({ stateId: payload.stateId, output: result });
    } catch (error) {
      console.error(error);

      let loggerError: LogReturn | null;
      if (error instanceof Error) {
        loggerError = context.logger.error(`Error: ${error}`, { error: error });
      } else if (error instanceof LogReturn) {
        loggerError = error;
      } else {
        loggerError = context.logger.error(`Error: ${error}`);
      }

      if (pluginOptions.postCommentOnError && loggerError) {
        await postComment(context, loggerError);
      }

      throw new HTTPException(500, { message: "Unexpected error" });
    }
  });

  return app;
}

async function postComment(context: Context, error: LogReturn) {
  if ("issue" in context.payload && context.payload.repository?.owner?.login) {
    await context.octokit.rest.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: `${error.logMessage.diff}\n<!--\n${sanitizeMetadata(error.metadata)}\n-->`,
    });
  } else {
    context.logger.info("Cannot post comment because issue is not found in the payload");
  }
}
