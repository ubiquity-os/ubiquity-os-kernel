import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { GithubPlugin, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getAgentMemorySnippet } from "../utils/agent-memory";
import { shouldSkipDuplicateCommentEvent } from "../utils/comment-dedupe";
import { getConfig } from "../utils/config";
import { callUbqAiRouter } from "../utils/ai-router";
import { getManifest } from "../utils/plugins";
import { withKernelContextSettingsIfNeeded, withKernelContextWorkflowInputsIfNeeded } from "../utils/plugin-dispatch-settings";
import { dispatchWorker, dispatchWorkflowWithRunUrl, getDefaultBranch } from "../utils/workflow-dispatch";
import { postHelpCommand } from "./help-command";
import { dispatchInternalAgent } from "./internal-agent";
import { buildRouterPrompt } from "./router-prompt";
import { callPersonalAgent } from "./personal-agent";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url";
import { resolveConversationKeyForContext } from "../utils/conversation-graph";
import { buildConversationContext } from "../utils/conversation-context";

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

  if (afterMention !== null) {
    if (context.payload.comment.user?.type === "User") {
      await addReactionEyes(context);
    }
    if (slashInvocation) {
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
    context.logger.warn(`No installation found, cannot invoke command`);
    return;
  }

  const requested = invocation.name.toLowerCase();
  if (requested === "help") {
    await postHelpCommand(context);
    return;
  }

  const config = await getConfig(context);
  if (!config) {
    context.logger.debug("No configuration was found");
    return;
  }
  const matches: { target: string | GithubPlugin; settings: (typeof config.plugins)[string]; manifest: Manifest; resolvedCommandName: string }[] = [];

  for (const [pluginKey, pluginSettings] of Object.entries(config.plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }

    const manifest = await getManifest(context, target);
    if (!manifest?.commands) continue;

    const resolvedCommandName =
      Object.keys(manifest.commands).find((name) => name.toLowerCase() === requested) ?? (manifest.commands[invocation.name] ? invocation.name : null);
    if (!resolvedCommandName) continue;

    matches.push({
      target,
      settings: pluginSettings,
      manifest,
      resolvedCommandName,
    });
  }

  if (!matches.length) {
    context.logger.warn({ command: invocation.name }, "No plugin found for slash command");
    return;
  }

  if (matches.length > 1) {
    context.logger.warn(
      { command: invocation.name, plugins: matches.map((m) => m.manifest.name) },
      "Multiple plugins matched slash command; using the last match"
    );
  }

  const match = matches[matches.length - 1];
  if (!match) return;

  const manifestCommand = match.manifest.commands?.[match.resolvedCommandName];
  const parameters = parseSlashCommandParameters(match.resolvedCommandName, invocation.rawArgs, manifestCommand?.parameters, context);
  const command = { name: match.resolvedCommandName, parameters };

  const isBotAuthor = context.payload.comment.user?.type !== "User";
  if (isBotAuthor && match.settings?.skipBotEvents) {
    context.logger.debug({ plugin: match.target, command: match.resolvedCommandName }, "Skipping slash command dispatch from bot author");
    return;
  }

  const plugin = match.target;
  const settings = withKernelContextSettingsIfNeeded(match.settings?.with, plugin, context.eventHandler.environment);

  const isGithubPluginObject = isGithubPlugin(plugin);
  const stateId = crypto.randomUUID();
  const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, command);

  context.logger.info({ plugin, isGithubPluginObject, command }, "Will attempt to call a plugin for slash command.");
  try {
    if (!isGithubPluginObject) {
      await dispatchWorker(plugin, await inputs.getInputs());
    } else {
      const baseInputs = (await inputs.getInputs()) as Record<string, string>;
      const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, () => context.eventHandler.getKernelPublicKeyPem());
      const runUrl = await dispatchWorkflowWithRunUrl(context, {
        owner: plugin.owner,
        repository: plugin.repo,
        workflowId: plugin.workflowId,
        ref: ref,
        inputs: workflowInputs,
      });
      await updateRequestCommentRunUrl(context, runUrl);
    }
  } catch (e) {
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin; skipping plugin");
  }
}

export type RouterDecision =
  | { action: "help" }
  | { action: "ignore" }
  | { action: "reply"; reply: string }
  | { action: "command"; command: { name: string; parameters?: unknown } }
  | { action: "agent"; task?: string };

export type CommandDescriptor = Readonly<{
  name: string;
  description: string;
  example: string;
  parameters?: unknown;
}>;

export function truncateForRouter(value: unknown, maxChars = 8000): string {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

export function tryParseRouterDecision(raw: string): RouterDecision | null {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned) as RouterDecision;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as RouterDecision;
    } catch {
      return null;
    }
  }
}

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
  await context.octokit.rest.issues.createComment({
    body: message,
    issue_number: context.payload.issue.number,
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
  });
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

async function getRecentCommentsForRouter(context: GitHubContext<"issue_comment.created">, limit: number): Promise<{ author: string; body: string }[]> {
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
  const pluginsWithManifest: { target: string | GithubPlugin; settings: (typeof config.plugins)[string]; manifest: Manifest }[] = [];
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
    const manifest = await getManifest(context, target);
    if (!manifest?.commands) continue;
    pluginsWithManifest.push({ target, settings: pluginSettings, manifest });
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

  const prompt = buildRouterPrompt({
    commands,
    recentCommentsDescription: "array of the last ~10 human comments: { author, body }",
    replyActionDescription: "post a comment",
  });

  let raw: string;
  try {
    raw = await callUbqAiRouter(context, prompt, {
      repositoryOwner: context.payload.repository.owner.login,
      repositoryName: context.payload.repository.name,
      issueNumber: context.payload.issue.number,
      issueTitle: context.payload.issue.title,
      issueBody,
      isPullRequest: Boolean(context.payload.issue.pull_request),
      labels,
      recentComments,
      agentMemory,
      conversationContext,
      author: context.payload.comment.user?.login,
      comment: context.payload.comment.body,
    });
  } catch (error) {
    context.logger.error({ err: error }, "Router call failed; ignoring mention");
    return;
  }

  context.logger.debug({ raw }, "Router output");

  const decision = tryParseRouterDecision(raw);
  if (!decision) {
    await postReply(context, raw);
    return;
  }

  if (decision.action === "ignore") return;
  if (decision.action === "help") {
    await postHelpCommand(context);
    return;
  }
  if (decision.action === "reply") {
    await postReply(context, decision.reply);
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

  const isGithubPluginObject = isGithubPlugin(plugin);
  const stateId = crypto.randomUUID();
  const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, command);

  context.logger.info({ plugin, isGithubPluginObject, command }, "Will dispatch command plugin.");
  try {
    if (!isGithubPluginObject) {
      await dispatchWorker(plugin, await inputs.getInputs());
    } else {
      const baseInputs = (await inputs.getInputs()) as Record<string, string>;
      const workflowInputs = await withKernelContextWorkflowInputsIfNeeded(baseInputs, plugin, () => context.eventHandler.getKernelPublicKeyPem());
      const runUrl = await dispatchWorkflowWithRunUrl(context, {
        owner: plugin.owner,
        repository: plugin.repo,
        workflowId: plugin.workflowId,
        ref,
        inputs: workflowInputs,
      });
      await updateRequestCommentRunUrl(context, runUrl);
    }
  } catch (e) {
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin; skipping plugin");
  }
}
