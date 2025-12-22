import { EmitterWebhookEvent } from "@octokit/webhooks";
import { logger as pinoLogger } from "../../logger/logger";
import { GitHubEventHandler } from "../github-event-handler";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { ResolvedPlugin, getManifest, getPluginsForEvent } from "../utils/plugins";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import issueCommentCreated from "./issue-comment-created";
import issueCommentEdited from "./issue-comment-edited";
import pullRequestReviewCommentCreated from "./pull-request-review-comment-created";
import pullRequestReviewCommentEdited from "./pull-request-review-comment-edited";
import handlePushEvent from "./push-event";

function tryCatchWrapper(fn: (event: EmitterWebhookEvent) => unknown, logger: typeof pinoLogger) {
  return async (event: EmitterWebhookEvent) => {
    try {
      await fn(event);
    } catch (error) {
      logger.error({ err: error, event }, "Error in event handler");
    }
  };
}

export function bindHandlers(eventHandler: GitHubEventHandler) {
  eventHandler.on("issue_comment.created", issueCommentCreated);
  eventHandler.on("issue_comment.edited", issueCommentEdited);
  eventHandler.on("pull_request_review_comment.created", pullRequestReviewCommentCreated);
  eventHandler.on("pull_request_review_comment.edited", pullRequestReviewCommentEdited);
  eventHandler.on("push", handlePushEvent);
  eventHandler.on("installation.created", () => {}); // No-op to handle event
  eventHandler.onAny(tryCatchWrapper((event) => handleEvent(event, eventHandler), eventHandler.logger)); // onAny should also receive GithubContext but the types in octokit/webhooks are weird
}

function extractLeadingSlashCommandName(body: string): string | null {
  const trimmed = body.trimStart();
  const match = /^\/([\w-]+)/u.exec(trimmed);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function extractSlashCommandNameFromCommentBody(body: string): string | null {
  const direct = extractLeadingSlashCommandName(body);
  if (direct) return direct;

  const mention = /@ubiquityos\b/i.exec(body);
  if (!mention || mention.index === undefined) return null;
  const afterMention = body.slice(mention.index + mention[0].length);
  return extractLeadingSlashCommandName(afterMention);
}

async function filterPluginsForSlashCommandEvent(
  context: GitHubContext,
  plugins: ResolvedPlugin[],
  slashCommandName: string
): Promise<ResolvedPlugin[]> {
  const filtered: ResolvedPlugin[] = [];
  for (const plugin of plugins) {
    try {
      const manifest = await getManifest(context, plugin.target);
      if (!manifest?.commands) {
        filtered.push(plugin);
        continue;
      }
      const commandNames = Object.keys(manifest.commands).map((name) => name.toLowerCase());
      if (commandNames.includes(slashCommandName)) {
        context.logger.debug(
          { plugin: plugin.key, command: slashCommandName },
          "Skipping global dispatch for command plugin; slash handler will dispatch"
        );
        continue;
      }
    } catch (error) {
      context.logger.debug({ plugin: plugin.key, err: error }, "Failed to inspect plugin manifest for slash-command filtering; allowing dispatch");
    }
    filtered.push(plugin);
  }
  return filtered;
}

async function handleEvent(event: EmitterWebhookEvent, eventHandler: InstanceType<typeof GitHubEventHandler>) {
  const context = eventHandler.transformEvent(event);

  // Skip plugin processing for workflow-related events to prevent infinite loops
  if (
    context.key.startsWith("workflow_") ||
    context.key.startsWith("check_") ||
    context.key === "deployment_status.created" ||
    context.key === "repository_dispatch.return-data-to-ubiquity-os-kernel" ||
    context.key.startsWith("check_run.") ||
    context.key.startsWith("check_suite.")
  ) {
    context.logger.debug({ event: context.key }, "Skipping plugin processing for workflow-related event to prevent loops");
    return;
  }

  const config = await getConfig(context);

  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }

  if (!("installation" in event.payload) || event.payload.installation?.id === undefined) {
    context.logger.warn("No installation found");
    return;
  }

  const resolvedPlugins = await getPluginsForEvent(context, config.plugins, context.key);

  if (context.key === "issue_comment.created" && "comment" in context.payload) {
    const commandName = extractSlashCommandNameFromCommentBody(String(context.payload.comment?.body ?? ""));
    if (commandName) {
      const filtered = await filterPluginsForSlashCommandEvent(context, resolvedPlugins, commandName);
      resolvedPlugins.length = 0;
      resolvedPlugins.push(...filtered);
    }
  }

  if (context.key === "pull_request_review_comment.created" && "comment" in context.payload) {
    const commandName = extractSlashCommandNameFromCommentBody(String(context.payload.comment?.body ?? ""));
    if (commandName) {
      const filtered = await filterPluginsForSlashCommandEvent(context, resolvedPlugins, commandName);
      resolvedPlugins.length = 0;
      resolvedPlugins.push(...filtered);
    }
  }

  if (resolvedPlugins.length === 0) {
    context.logger.debug("No handler found for event");
    return;
  }

  context.logger.info({ plugins: resolvedPlugins.map((plugin) => plugin.key) }, "Will call plugins for event");

  for (const pluginEntry of resolvedPlugins) {
    const plugin = pluginEntry.target;
    const settings = pluginEntry.settings;
    const isGithubPluginObject = isGithubPlugin(plugin);
    context.logger.debug({ plugin: pluginEntry.key }, "Calling handler for event");

    const stateId = crypto.randomUUID();
    const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
    const token = await eventHandler.getToken(event.payload.installation.id);
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, event.payload, settings?.with, token, ref, null);

    // We wrap the dispatch so a failing plugin doesn't break the whole execution
    try {
      context.logger.debug({ plugin: pluginEntry.key }, "Dispatching event");
      if (!isGithubPluginObject) {
        await dispatchWorker(plugin, await inputs.getInputs());
      } else {
        await dispatchWorkflow(context, {
          owner: plugin.owner,
          repository: plugin.repo,
          workflowId: plugin.workflowId,
          ref,
          inputs: await inputs.getInputs(),
        });
      }
      context.logger.debug({ plugin: pluginEntry.key }, "Event dispatched");
    } catch (e) {
      context.logger.error({ plugin: pluginEntry.key, err: e }, "Error processing plugin; skipping");
    }
  }
}
