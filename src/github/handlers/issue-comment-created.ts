import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { GithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration.ts";
import { getAgentMemorySnippet, listAgentMemoryEntries, upsertAgentRunMemory } from "../utils/agent-memory.ts";
import { shouldSkipDuplicateCommentEvent } from "../utils/comment-dedupe.ts";
import { getConfig } from "../utils/config.ts";
import { getManifestResolution } from "../utils/plugins.ts";
import { withKernelContextSettingsIfNeeded } from "../utils/plugin-dispatch-settings.ts";
import { dispatchPluginTarget, resolvePluginDispatchTarget } from "../utils/plugin-dispatch.ts";
import { postHelpCommand } from "./help-command.ts";
import { postVersionCommand } from "./version-command.ts";
import { dispatchInternalAgent } from "./internal-agent.ts";
import { buildRouterPrompt } from "./router-prompt.ts";
import { callPersonalAgent } from "./personal-agent.ts";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url.ts";
import { resolveConversationKeyForContext } from "../utils/conversation-graph.ts";
import { buildConversationContext } from "../utils/conversation-context.ts";
import { getRouterDecision } from "./router-decision.ts";

type SlashCommandInvocation = {
  name: string;
  rawArgs: string;
};

async function addReactionEyes(context: GitHubContext<"issue_comment.created">) {
  const commentId = context.payload.comment.id;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  try {
    await context.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: "eyes",
    });
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to add 👀 reaction (non-fatal)");
  }
}

async function isExternalContributor(context: GitHubContext<"issue_comment.created">) {
  const {
    octokit,
    payload: {
      comment: { user },
    },
  } = context;
  if (!user) {
    return true;
  }
  const permissionLevel = await octokit.rest.repos.getCollaboratorPermissionLevel({
    username: user.login,
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
  });
  const role = permissionLevel.data.role_name?.toLowerCase();
  return role === "none" || role === "read";
}

async function getPreviousComment(context: GitHubContext<"issue_comment.created">) {
  const currentCommentId = context.payload.comment.id;

  try {
    const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      per_page: 100,
    });

    const filteredComments = comments.filter((comment) => comment.user?.type === "User");
    const currentIndex = filteredComments.findIndex((comment) => comment.id === currentCommentId);
    if (currentIndex > 0) {
      return filteredComments[currentIndex - 1];
    }
    return null;
  } catch (e) {
    context.logger.warn(e, "Failed to fetch previous comment");
    return null;
  }
}

async function isUserHelpRequest(context: GitHubContext<"issue_comment.created">) {
  const comment = context.payload.comment;
  const body = comment.body.trim().toLowerCase();
  const issueAuthor = context.payload.issue.user?.login;
  const commentAuthor = context.payload.comment.user?.login;

  // The author of that comment is not an external contributor, or not a human
  if (comment.user?.type !== "User" || !(await isExternalContributor(context))) {
    context.logger.warn(`Comment author is not an external contributor, or not a human, will ignore the help request.`);
    return false;
  }
  // We also ignore pull-requests
  if (context.payload.issue.pull_request) {
    context.logger.warn("Help requests cannot be made in pull requests, will ignore the help request.");
    return false;
  }
  // The author was not tagged in the message
  if (body.search(`@${issueAuthor}`) === -1 || issueAuthor === commentAuthor) {
    context.logger.warn({ issueAuthor, commentAuthor, body }, `Comment author was not tagged in the message or tagged itself, will ignore the help request.`);
    return false;
  }
  // Get the previous comment, and if it was from the author, consider that a conversation is already ongoing
  const previousComment = await getPreviousComment(context);
  context.logger.debug(
    {
      previousComment: previousComment?.user?.login,
      issueAuthor,
    },
    "isUserHelpRequest"
  );
  return previousComment?.user?.login !== issueAuthor;
}

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim();
  const bodyLower = body.toLowerCase();
  const afterMention = extractAfterUbiquityosMention(body);
  const slashInvocation = afterMention ? extractSlashCommandInvocation(afterMention) : extractSlashCommandInvocation(body);
  const isHuman = context.payload.comment.user?.type === "User";
  const shouldSkip = await shouldSkipDuplicateCommentEvent({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    eventName: context.key,
    commentId: context.payload.comment.id,
  });
  if (shouldSkip) {
    context.logger.info({ commentId: context.payload.comment.id }, "Skipping duplicate comment event");
    return;
  }

  if (!isHuman && !slashInvocation && afterMention === null) {
    context.logger.debug({ author: context.payload.comment.user?.login, type: context.payload.comment.user?.type }, "Ignoring comment from non-human author");
    return;
  }

  if (bodyLower.startsWith(`/help`)) {
    await postHelpCommand(context);
    return;
  }

  if (bodyLower.startsWith(`/version`)) {
    await postVersionCommand(context);
    return;
  }

  if (afterMention !== null) {
    if (context.payload.comment.user?.type === "User") {
      await addReactionEyes(context);
    }
    if (slashInvocation) {
      if (slashInvocation.name === "help") {
        await postHelpCommand(context);
        return;
      }
      if (slashInvocation.name === "version") {
        await postVersionCommand(context);
        return;
      }
      await dispatchSlashCommand(context, slashInvocation);
      return;
    }
    const agentPrefixMatch = /^agent\b/i.exec(afterMention);
    if (agentPrefixMatch) {
      const task = afterMention.replace(/^agent\b/i, "").trim() || body.trim();
      await dispatchInternalAgent(context, task, { postReply: (reply) => postReply(context, reply) });
      return;
    }
    await commandRouter(context);
  } else if (body.startsWith(`/`)) {
    const slashInvocation = extractSlashCommandInvocation(body);
    if (slashInvocation) {
      await dispatchSlashCommand(context, slashInvocation);
      return;
    }
  } else if (isHuman && (await isUserHelpRequest(context))) {
    const issueAuthor = context.payload.issue.user?.login;
    context.payload.comment.body = context.payload.comment.body.replace(`@${issueAuthor}`, `@ubiquityos`);
    await commandRouter(context);
  } else {
    await callPersonalAgent(context);
  }
}

export function extractSlashCommandInvocation(text: string): SlashCommandInvocation | null {
  const match = /^\s*\/([\w-]+)\b(.*)$/s.exec(text);
  if (!match) return null;
  return {
    name: match[1],
    rawArgs: (match[2] ?? "").trim(),
  };
}

export function extractAfterUbiquityosMention(text: string): string | null {
  const match = /@ubiquityos\b/i.exec(text);
  if (!match || match.index === undefined) return null;
  return text.slice(match.index + match[0].length).trim();
}

function listUserMentions(text: string): string[] {
  return [...text.matchAll(/@([a-z0-9-_]+)/gi)].map((match) => match[1]);
}

export function parseSlashCommandParameters(
  commandName: string,
  rawArgs: string,
  parametersSpec: unknown,
  context: GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">
) {
  const paramObject = typeof parametersSpec === "object" && parametersSpec !== null ? (parametersSpec as Record<string, unknown>) : {};
  const specProperties =
    typeof (paramObject as Record<string, unknown>).properties === "object" && (paramObject as Record<string, unknown>).properties !== null
      ? ((paramObject as Record<string, unknown>).properties as Record<string, unknown>)
      : paramObject;

  const propertyNames = Object.keys(specProperties);
  if (!propertyNames.length) return {};

  const args = rawArgs.trim();

  if (propertyNames.includes("teammates")) {
    const teammates = listUserMentions(args);
    return { teammates };
  }

  if (propertyNames.includes("username")) {
    const first = args.split(/\s+/).find(Boolean) ?? "";
    const username = (first.startsWith("@") ? first.slice(1) : first) || context.payload.comment.user?.login || "";
    return { username };
  }

  if (propertyNames.includes("walletAddress") && propertyNames.includes("unset")) {
    const token = args.split(/\s+/).find(Boolean)?.toLowerCase() ?? "";
    const shouldUnset = token === "unset";
    return { walletAddress: shouldUnset ? "" : args, unset: shouldUnset };
  }

  if (propertyNames.length === 1) {
    return { [propertyNames[0]]: args };
  }

  if (commandName.toLowerCase() === "stop") {
    return {};
  }

  return {};
}

async function dispatchSlashCommand(context: GitHubContext<"issue_comment.created">, invocation: SlashCommandInvocation) {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn(`No installation found, cannot route slash command`);
    return;
  }

  const slashCommandName = invocation.name;
  const config = await getConfig(context);
  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }

  const isBotAuthor = context.payload.comment.user?.type !== "User";
  const pluginsWithManifest: { target: string | GithubPlugin; settings: (typeof config.plugins)[string]; manifest: Manifest; manifestRef?: string }[] = [];

  for (const [pluginKey, pluginSettings] of Object.entries(config.plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    if (isBotAuthor && pluginSettings?.skipBotEvents) {
      continue;
    }
    const { manifest, ref: manifestRef } = await getManifestResolution(context, target);
    if (!manifest?.commands) continue;
    pluginsWithManifest.push({ target, settings: pluginSettings, manifest, manifestRef });
  }

  let matchedPluginWithManifest: (typeof pluginsWithManifest)[number] | undefined;
  for (let i = pluginsWithManifest.length - 1; i >= 0; i--) {
    const candidate = pluginsWithManifest[i];
    if (candidate?.manifest?.commands?.[slashCommandName] !== undefined) {
      matchedPluginWithManifest = candidate;
      break;
    }
  }

  if (!matchedPluginWithManifest) {
    context.logger.debug({ slashCommandName }, "No plugin found for slash command.");
    return;
  }

  const commandSpec = matchedPluginWithManifest.manifest.commands?.[slashCommandName];
  const parameters = parseSlashCommandParameters(slashCommandName, invocation.rawArgs, commandSpec?.parameters, context);

  const command = {
    name: slashCommandName,
    parameters,
  };

  const plugin = matchedPluginWithManifest.target;
  const settings = withKernelContextSettingsIfNeeded(matchedPluginWithManifest.settings?.with, plugin, context.eventHandler.environment);

  const stateId = crypto.randomUUID();
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const dispatchTarget = await resolvePluginDispatchTarget({
    context,
    plugin,
    manifest: matchedPluginWithManifest.manifest,
    manifestRef: matchedPluginWithManifest.manifestRef,
  });
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, dispatchTarget.ref, command);

  context.logger.info({ plugin, worker: dispatchTarget.kind === "worker", command }, "Will dispatch slash command plugin.");
  try {
    const { target, runUrl } = await dispatchPluginTarget({
      context,
      plugin,
      target: dispatchTarget,
      pluginInput: inputs,
      withRunUrl: true,
      getKernelPublicKeyPem: () => context.eventHandler.getKernelPublicKeyPem(),
    });
    if (target.kind === "workflow") {
      await updateRequestCommentRunUrl(context, runUrl ?? null);
    }
  } catch (e) {
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin; skipping plugin");
  }
}

export function truncateForRouter(text?: string | null): string {
  const normalized = text ?? "";
  if (normalized.length <= 1000) return normalized;
  return `${normalized.slice(0, 500)}\n...\n${normalized.slice(-500)}`;
}

type CommandDescriptor = {
  name: string;
  description: string;
  example: string;
  parameters: unknown;
};

function getAgentTaskFromParameters(parameters: unknown): string | null {
  if (typeof parameters !== "object" || parameters === null) return null;
  if (!("task" in parameters)) return null;
  const task = (parameters as { task?: unknown }).task;
  if (typeof task !== "string") return null;
  const trimmed = task.trim();
  return trimmed ? trimmed : null;
}

async function postReply(context: GitHubContext<"issue_comment.created">, body: string) {
  const message = body.trim();
  if (!message) return;
  try {
    await context.octokit.rest.issues.createComment({
      body: message,
      issue_number: context.payload.issue.number,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    });
  } catch (error) {
    context.logger.warn({ err: error, issueNumber: context.payload.issue.number }, "Failed to post reply (non-fatal)");
  }
}

export function describeCommands(manifests: Manifest[]): CommandDescriptor[] {
  const out = new Map<string, CommandDescriptor>();

  function setCommand(command: CommandDescriptor) {
    const key = command.name.toLowerCase();
    out.delete(key);
    out.set(key, command);
  }

  for (const manifest of manifests) {
    for (const [name, command] of Object.entries(manifest.commands ?? {})) {
      setCommand({
        name,
        description: command.description,
        example: command["ubiquity:example"],
        parameters: command.parameters,
      });
    }
  }

  setCommand({ name: "help", description: "Show all available commands and examples.", example: "/help", parameters: {} });
  setCommand({
    name: "agent",
    description: "Run the full-power agent to handle complex requests.",
    example: "@ubiquityos <request>",
    parameters: {},
  });

  return [...out.values()];
}

export function getIssueLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names = labels
    .map((label) => {
      if (typeof label === "string") return label;
      if (typeof label === "object" && label !== null && "name" in label) {
        const name = (label as { name?: unknown }).name;
        return typeof name === "string" ? name : null;
      }
      return null;
    })
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

async function getRecentCommentsForRouter(
  context: GitHubContext<"issue_comment.created">,
  limit: number
): Promise<{ id: number; author: string; body: string }[]> {
  try {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const issue_number = context.payload.issue.number;
    const { data } = await context.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number,
      per_page: Math.min(30, Math.max(1, limit * 3)),
      sort: "created",
      direction: "desc",
    });

    return data
      .filter((comment) => comment.user?.type === "User")
      .slice(0, limit)
      .reverse()
      .map((comment) => ({
        id: comment.id ?? 0,
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
      }));
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to fetch recent comments for router (non-fatal)");
    return [];
  }
}

async function commandRouter(context: GitHubContext<"issue_comment.created">) {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn(`No installation found, cannot route command`);
    return;
  }

  const config = await getConfig(context);
  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }
  const isBotAuthor = context.payload.comment.user?.type !== "User";
  const pluginsWithManifest: { target: string | GithubPlugin; settings: (typeof config.plugins)[string]; manifest: Manifest; manifestRef?: string }[] = [];
  const manifests: Manifest[] = [];

  for (const [pluginKey, pluginSettings] of Object.entries(config.plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    if (isBotAuthor && pluginSettings?.skipBotEvents) {
      continue;
    }
    const { manifest, ref: manifestRef } = await getManifestResolution(context, target);
    if (!manifest?.commands) continue;
    pluginsWithManifest.push({ target, settings: pluginSettings, manifest, manifestRef });
    manifests.push(manifest);
  }

  const commands = describeCommands(manifests);
  const recentComments = await getRecentCommentsForRouter(context, 10);
  const labels = getIssueLabelNames(context.payload.issue.labels);
  const issueBody = truncateForRouter(context.payload.issue.body);
  const conversation = await resolveConversationKeyForContext(context, context.logger);
  const conversationContext = conversation ? await buildConversationContext({ context, conversation, maxItems: 5, maxChars: 1600 }) : "";
  const agentMemory = await getAgentMemorySnippet({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    limit: 6,
    maxChars: 1200,
    scopeKey: conversation?.key,
    logger: context.logger,
  });
  const handledEntries = await listAgentMemoryEntries({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    limit: 50,
    scopeKey: conversation?.key,
    logger: context.logger,
  });
  const handledCommentIds = new Set(handledEntries.filter((entry) => entry.status === "reply-posted" && entry.stateId).map((entry) => String(entry.stateId)));
  const filteredRecentComments = handledCommentIds.size ? recentComments.filter((comment) => !handledCommentIds.has(String(comment.id))) : recentComments;

  const prompt = buildRouterPrompt({
    commands,
    recentCommentsDescription: "array of the last ~10 human comments: { id, author, body }",
    replyActionDescription: "post a comment",
  });

  const routerResult = await getRouterDecision(context, prompt, {
    repositoryOwner: context.payload.repository.owner.login,
    repositoryName: context.payload.repository.name,
    issueNumber: context.payload.issue.number,
    issueTitle: context.payload.issue.title,
    issueBody,
    isPullRequest: Boolean(context.payload.issue.pull_request),
    labels,
    recentComments: filteredRecentComments,
    agentMemory,
    conversationContext,
    author: context.payload.comment.user?.login,
    comment: context.payload.comment.body,
  });
  if (!routerResult) return;
  const { raw, decision } = routerResult;
  if (!decision) {
    const rawSnippet = String(raw ?? "");
    const trimmedSnippet = rawSnippet.length > 500 ? `${rawSnippet.slice(0, 500)}...` : rawSnippet;
    context.logger.warn({ raw: trimmedSnippet }, "Failed to parse router decision");
    await postReply(context, "I couldn't understand that request. Try `@ubiquityos help`.");
    return;
  }

  if (decision.action === "ignore") return;
  if (decision.action === "help") {
    await postHelpCommand(context);
    return;
  }
  if (decision.action === "reply") {
    await postReply(context, decision.reply);
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const conversationKey = conversation?.key;
    const commentId = context.payload.comment.id;
    if (commentId) {
      try {
        await upsertAgentRunMemory({
          owner,
          repo,
          scopeKey: conversationKey,
          entry: {
            kind: "agent_run",
            stateId: String(commentId),
            status: "reply-posted",
            issueNumber: context.payload.issue.number,
            updatedAt: new Date().toISOString(),
            summary: decision.reply,
          },
          logger: context.logger,
        });
      } catch (error) {
        context.logger.debug({ err: error }, "Failed to mark router reply as handled (non-fatal)");
      }
    }
    return;
  }
  if (decision.action === "agent") {
    const task = String(decision.task ?? "").trim() || extractAfterUbiquityosMention(context.payload.comment.body) || context.payload.comment.body.trim();
    await dispatchInternalAgent(context, task, { postReply: (reply) => postReply(context, reply) });
    return;
  }

  const commandName = decision.command?.name;
  if (!commandName || typeof commandName !== "string") {
    await postReply(context, "I couldn't determine which command to run. Try `@ubiquityos help`.");
    return;
  }

  if (commandName === "help") {
    await postHelpCommand(context);
    return;
  }
  if (commandName === "version") {
    await postVersionCommand(context);
    return;
  }
  if (commandName === "agent") {
    const task =
      getAgentTaskFromParameters(decision.command?.parameters) ??
      extractAfterUbiquityosMention(context.payload.comment.body) ??
      context.payload.comment.body.trim();
    await dispatchInternalAgent(context, task, { postReply: (reply) => postReply(context, reply) });
    return;
  }

  let pluginWithManifest: (typeof pluginsWithManifest)[number] | undefined;
  for (let i = pluginsWithManifest.length - 1; i >= 0; i--) {
    const candidate = pluginsWithManifest[i];
    if (candidate?.manifest?.commands?.[commandName] !== undefined) {
      pluginWithManifest = candidate;
      break;
    }
  }
  if (!pluginWithManifest) {
    await postReply(context, `I couldn't find a plugin for \`/${commandName}\`. Try \`@ubiquityos help\`.`);
    return;
  }

  const command = {
    name: commandName,
    parameters: decision.command?.parameters ?? null,
  };

  const plugin = pluginWithManifest.target;
  const settings = withKernelContextSettingsIfNeeded(pluginWithManifest.settings?.with, plugin, context.eventHandler.environment);

  const stateId = crypto.randomUUID();
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const dispatchTarget = await resolvePluginDispatchTarget({
    context,
    plugin,
    manifest: pluginWithManifest.manifest,
    manifestRef: pluginWithManifest.manifestRef,
  });
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, dispatchTarget.ref, command);

  context.logger.info({ plugin, worker: dispatchTarget.kind === "worker", command }, "Will dispatch command plugin.");
  try {
    const { target, runUrl } = await dispatchPluginTarget({
      context,
      plugin,
      target: dispatchTarget,
      pluginInput: inputs,
      withRunUrl: true,
      getKernelPublicKeyPem: () => context.eventHandler.getKernelPublicKeyPem(),
    });
    if (target.kind === "workflow") {
      await updateRequestCommentRunUrl(context, runUrl ?? null);
    }
  } catch (e) {
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin; skipping plugin");
  }
}
