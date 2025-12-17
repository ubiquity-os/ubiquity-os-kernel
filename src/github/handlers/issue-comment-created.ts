import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { GithubPlugin, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { createKernelAttestationToken } from "../utils/kernel-attestation";
import { getManifest } from "../utils/plugins";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { postHelpCommand } from "./help-command";
import { callPersonalAgent } from "./personal-agent";

type SlashCommandInvocation = {
  name: string;
  rawArgs: string;
};

async function isUserContributor(context: GitHubContext<"issue_comment.created">) {
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

  // The author of that comment is not a contributor, or not a human
  if (comment.user?.type !== "User" || !(await isUserContributor(context))) {
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

  if (bodyLower.startsWith(`/help`)) {
    await postHelpCommand(context);
    return;
  }

  const afterMention = extractAfterUbiquityosMention(body);
  if (afterMention !== null) {
    const slashInvocation = extractSlashCommandInvocation(afterMention);
    if (slashInvocation) {
      await dispatchSlashCommand(context, slashInvocation);
      return;
    }
    await commandRouter(context);
  } else if (body.startsWith(`/`)) {
    const slashInvocation = extractSlashCommandInvocation(body);
    if (slashInvocation) {
      await dispatchSlashCommand(context, slashInvocation);
      return;
    }
  } else if (await isUserHelpRequest(context)) {
    const issueAuthor = context.payload.issue.user?.login;
    context.payload.comment.body = context.payload.comment.body.replace(`@${issueAuthor}`, `@ubiquityos`);
    await commandRouter(context);
  } else {
    await callPersonalAgent(context);
  }
}

function extractSlashCommandInvocation(text: string): SlashCommandInvocation | null {
  const match = /^\s*\/([A-Za-z-_]+)\b(.*)$/s.exec(text);
  if (!match) return null;
  return {
    name: match[1],
    rawArgs: (match[2] ?? "").trim(),
  };
}

function extractAfterUbiquityosMention(text: string): string | null {
  const match = /@ubiquityos\b/i.exec(text);
  if (!match || match.index === undefined) return null;
  return text.slice(match.index + match[0].length).trim();
}

function listUserMentions(text: string): string[] {
  return [...text.matchAll(/@([a-z0-9-_]+)/gi)].map((match) => match[1]);
}

function parseSlashCommandParameters(commandName: string, rawArgs: string, parametersSpec: unknown, context: GitHubContext<"issue_comment.created">) {
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

  const plugin = match.target;
  const settings = match.settings?.with;

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
      await dispatchWorkflow(context, {
        owner: plugin.owner,
        repository: plugin.repo,
        workflowId: plugin.workflowId,
        ref: ref,
        inputs: await inputs.getInputs(),
      });
    }
  } catch (e) {
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin; skipping plugin");
  }
}

type RouterDecision =
  | { action: "help" }
  | { action: "ignore" }
  | { action: "reply"; reply: string }
  | { action: "command"; command: { name: string; parameters?: unknown } }
  | { action: "agent"; task?: string };

type CommandDescriptor = Readonly<{
  name: string;
  description: string;
  example: string;
  parameters?: unknown;
}>;

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

function tryParseRouterDecision(raw: string): RouterDecision | null {
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

async function callUbqAiRouter(context: GitHubContext<"issue_comment.created">, prompt: string): Promise<string> {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    throw new Error("Missing installation id");
  }

  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const installationId = context.payload.installation.id;

  const token = await context.eventHandler.getToken(installationId);
  const kernelToken = await createKernelAttestationToken({
    sign: (payload) => context.eventHandler.signPayload(payload),
    owner,
    repo,
    installationId,
    authToken: token,
    stateId: crypto.randomUUID(),
    ttlSeconds: 120,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://ai.ubq.fi/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Owner": owner,
        "X-GitHub-Repo": repo,
        "X-GitHub-Installation-Id": String(installationId),
        "X-Ubiquity-Kernel-Token": kernelToken,
      },
      body: JSON.stringify({
        model: "gpt-5.2-chat-latest",
        reasoning_effort: "none",
        stream: false,
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: JSON.stringify({
              repositoryOwner: owner,
              repositoryName: repo,
              issueNumber: context.payload.issue.number,
              author: context.payload.comment.user?.login,
              comment: context.payload.comment.body,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`ai.ubq.fi error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("ai.ubq.fi: missing assistant content");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchInternalAgent(context: GitHubContext<"issue_comment.created">, task: string) {
  const agentOwner = context.eventHandler.agent.owner;
  const agentRepo = context.eventHandler.agent.repo;
  const agentWorkflowId = context.eventHandler.agent.workflowId;
  const agentWorkflowUrl = `https://github.com/${agentOwner}/${agentRepo}/actions/workflows/${agentWorkflowId}`;

  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn("No installation found, cannot dispatch agent");
    return;
  }

  try {
    const stateId = crypto.randomUUID();
    const ref = await getDefaultBranch(context, agentOwner, agentRepo);
    const token = await context.eventHandler.getToken(context.payload.installation.id);
    const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, {}, token, ref, { name: "agent", parameters: { task } });

    await dispatchWorkflow(context, {
      owner: agentOwner,
      repository: agentRepo,
      workflowId: agentWorkflowId,
      ref,
      inputs: await inputs.getInputs(),
    });
  } catch (error) {
    context.logger.error({ err: error }, "Failed to dispatch internal agent workflow");
    const message = error instanceof Error ? error.message : String(error);
    await postReply(
      context,
      [
        "I couldn't start the agent run.",
        message ? `Error: ${message}` : null,
        "",
        `Actions workflow: ${agentWorkflowUrl}`,
        "",
        "If you're testing a feature branch, note that GitHub's workflow_dispatch API only triggers workflows that exist on the repo's default branch.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

function describeCommands(manifests: Manifest[]): CommandDescriptor[] {
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

async function commandRouter(context: GitHubContext<"issue_comment.created">) {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn(`No installation found, cannot route command`);
    return;
  }

  const config = await getConfig(context);
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
    const manifest = await getManifest(context, target);
    if (!manifest?.commands) continue;
    pluginsWithManifest.push({ target, settings: pluginSettings, manifest });
    manifests.push(manifest);
  }

  const commands = describeCommands(manifests);

  const prompt = `
You are **UbiquityOS**, a GitHub App assistant.

You will receive a single JSON object with:
- repositoryOwner
- repositoryName
- issueNumber
- author
- comment (a GitHub comment that mentions "@ubiquityos")

You also have access to a list of available commands (including their examples and JSON parameter schemas).

Return **ONLY** a JSON object matching ONE of these shapes (no markdown, no code fences):

1) Help:
{ "action": "help" }

2) Ignore:
{ "action": "ignore" }

3) Plain reply (post a comment):
{ "action": "reply", "reply": "..." }

4) Invoke a command plugin:
{ "action": "command", "command": { "name": "<commandName>", "parameters": { ... } } }

5) Escalate to the full agent runner (for complex, multi-step, repo edits, or label/spec work):
{ "action": "agent", "task": "..." }

Rules:
- Prefer an existing command when it clearly fits.
- Use "help" when asked for available commands / how to use.
- Use "reply" for questions, discussion, or research that doesn't need execution.
- Use "agent" for anything that requires repo changes, reading long threads, rewriting specs, setting labels/time estimates, or GitHub operations not covered by commands.
- Never invent a command name; choose from the provided list.
- If parameters are unclear, use "reply" to ask a single clarifying question.

Available commands (JSON):
${JSON.stringify(commands)}
`.trim();

  let raw: string;
  try {
    raw = await callUbqAiRouter(context, prompt);
  } catch (error) {
    context.logger.error({ err: error }, "Router call failed");
    await postReply(context, "I couldn't reach the router model right now. Please try again in a moment.");
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
    await dispatchInternalAgent(context, task);
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
    await dispatchInternalAgent(context, task);
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
  const settings = pluginWithManifest.settings?.with;

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
      await dispatchWorkflow(context, {
        owner: plugin.owner,
        repository: plugin.repo,
        workflowId: plugin.workflowId,
        ref,
        inputs: await inputs.getInputs(),
      });
    }
  } catch (e) {
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin; skipping plugin");
  }
}
