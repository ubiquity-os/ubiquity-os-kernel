import * as core from "@actions/core";
import * as github from "@actions/github";
import { EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { Type as T, TAnySchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { LOG_LEVEL, LogLevel, LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { config } from "dotenv";
import { Context } from "./context";
import { customOctokit } from "./octokit";
import { sanitizeMetadata } from "./util";
import { verifySignature } from "./signature";
import { KERNEL_PUBLIC_KEY } from "./constants";
import { jsonType } from "../types/util";
import { commandCallSchema } from "../types/command";

config();

interface Options {
  logLevel?: LogLevel;
  postCommentOnError?: boolean;
  settingsSchema?: TAnySchema;
  envSchema?: TAnySchema;
  kernelPublicKey?: string;
  disableSignatureVerification?: boolean; // only use for local development
}

const inputSchema = T.Object({
  stateId: T.String(),
  eventName: T.String(),
  eventPayload: jsonType(T.Record(T.String(), T.Any())),
  command: jsonType(commandCallSchema),
  authToken: T.String(),
  settings: jsonType(T.Record(T.String(), T.Any())),
  ref: T.String(),
  signature: T.String(),
});

export async function createActionsPlugin<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName>(
  handler: (context: Context<TConfig, TEnv, TSupportedEvents>) => Promise<Record<string, unknown> | undefined>,
  options?: Options
) {
  const pluginOptions = {
    logLevel: options?.logLevel || LOG_LEVEL.INFO,
    postCommentOnError: options?.postCommentOnError || true,
    settingsSchema: options?.settingsSchema,
    envSchema: options?.envSchema,
    kernelPublicKey: options?.kernelPublicKey || KERNEL_PUBLIC_KEY,
    disableSignatureVerification: options?.disableSignatureVerification || false,
  };

  const pluginGithubToken = process.env.PLUGIN_GITHUB_TOKEN;
  if (!pluginGithubToken) {
    core.setFailed("Error: PLUGIN_GITHUB_TOKEN env is not set");
    return;
  }

  const body = github.context.payload.inputs;
  const signature = body.signature;
  if (!pluginOptions.disableSignatureVerification && !(await verifySignature(pluginOptions.kernelPublicKey, body, signature))) {
    core.setFailed(`Error: Invalid signature`);
    return;
  }

  const inputs = Value.Decode(inputSchema, github.context.payload.inputs);

  let config: TConfig;
  if (pluginOptions.settingsSchema) {
    config = Value.Decode(pluginOptions.settingsSchema, Value.Default(pluginOptions.settingsSchema, inputs.settings));
  } else {
    config = inputs.settings as TConfig;
  }

  let env: TEnv;
  if (pluginOptions.envSchema) {
    env = Value.Decode(pluginOptions.envSchema, Value.Default(pluginOptions.envSchema, process.env));
  } else {
    env = process.env as TEnv;
  }

  const context: Context<TConfig, TEnv, TSupportedEvents> = {
    eventName: inputs.eventName as TSupportedEvents,
    payload: inputs.eventPayload,
    command: inputs.command,
    octokit: new customOctokit({ auth: inputs.authToken }),
    config: config,
    env: env,
    logger: new Logs(pluginOptions.logLevel),
  };

  try {
    const result = await handler(context);
    core.setOutput("result", result);
    await returnDataToKernel(pluginGithubToken, inputs.stateId, result);
  } catch (error) {
    console.error(error);

    let loggerError: LogReturn | null;
    if (error instanceof Error) {
      core.setFailed(error);
      loggerError = context.logger.error(`Error: ${error}`, { error: error });
    } else if (error instanceof LogReturn) {
      core.setFailed(error.logMessage.raw);
      loggerError = error;
    } else {
      core.setFailed(`Error: ${error}`);
      loggerError = context.logger.error(`Error: ${error}`);
    }

    if (pluginOptions.postCommentOnError && loggerError) {
      await postComment(context, loggerError);
    }
  }
}

async function postComment(context: Context, error: LogReturn) {
  if ("issue" in context.payload && context.payload.repository?.owner?.login) {
    await context.octokit.rest.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: `${error.logMessage.diff}\n<!--\n${getGithubWorkflowRunUrl()}\n${sanitizeMetadata(error.metadata)}\n-->`,
    });
  } else {
    context.logger.info("Cannot post comment because issue is not found in the payload");
  }
}

function getGithubWorkflowRunUrl() {
  return `${github.context.payload.repository?.html_url}/actions/runs/${github.context.runId}`;
}

async function returnDataToKernel(repoToken: string, stateId: string, output: object | undefined) {
  const octokit = new customOctokit({ auth: repoToken });
  await octokit.rest.repos.createDispatchEvent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    event_type: "return-data-to-ubiquity-os-kernel",
    client_payload: {
      state_id: stateId,
      output: output ? JSON.stringify(output) : null,
    },
  });
}
