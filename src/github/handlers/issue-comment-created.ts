import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { GithubPlugin, isGithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
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
  } else if (bodyLower.startsWith(`@ubiquityos`)) {
    const afterMention = body.replace(/^@ubiquityos\b/i, "").trim();
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
      Object.keys(manifest.commands).find((name) => name.toLowerCase() === requested) ??
      (manifest.commands[invocation.name] ? invocation.name : null);
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
      "Multiple plugins matched slash command; using the first match"
    );
  }

  const match = matches[0];
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

interface OpenAiFunction {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean | null;
  };
}

const embeddedCommands: Array<OpenAiFunction> = [
  {
    type: "function",
    function: {
      name: "help",
      description: "Shows all available commands and their examples",
      strict: false,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

async function commandRouter(context: GitHubContext<"issue_comment.created">) {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    context.logger.warn(`No installation found, cannot invoke command`);
    return;
  }

  const commands = [...embeddedCommands];
  const config = await getConfig(context);
  const pluginsWithManifest: { target: string | GithubPlugin; settings: (typeof config.plugins)[string]; manifest: Manifest }[] = [];
  for (const [pluginKey, pluginSettings] of Object.entries(config.plugins)) {
    let target: string | GithubPlugin;
    try {
      target = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    const manifest = await getManifest(context, target);
    if (!manifest?.commands) {
      continue;
    }
    pluginsWithManifest.push({
      target,
      settings: pluginSettings,
      manifest,
    });
    for (const [name, command] of Object.entries(manifest.commands)) {
      commands.push({
        type: "function",
        function: {
          name: name,
          description: command.description,
          parameters: command.parameters
            ? {
                ...command.parameters,
                required: Object.keys(command.parameters?.properties ?? {}),
                additionalProperties: false,
              }
            : undefined,
          strict: true,
        },
      });
    }
  }

  context.logger.debug(commands, "Available commands");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  const response = await (async () => {
    try {
      return await context.openAi.chat.completions.create({
        model: context.llm,
        signal: controller.signal,
        messages: [
          {
            role: "system",
            content: [
              {
                text: `
You are a GitHub bot named **UbiquityOS**. You receive a single JSON object and OPTIONAL tool definitions (functions). Your job is to either (a) choose exactly one appropriate tool to call with strictly valid JSON arguments, or (b) produce a plain natural language message WITHOUT calling any tool.

### Input JSON fields
- repositoryOwner
- repositoryName
- issueNumber
- author
- comment  (natural language text mentioning "@UbiquityOS")

### Tool Calling Rules (CRITICAL)
1. Only call a tool if the user's comment clearly maps to a known command/function provided in the current tool list (the "tools" array).
2. If the request is vague, conversational, a greeting, gratitude, or cannot be unambiguously mapped: DO NOT call a tool. Return a short helpful textual reply instead.
3. If the user asks for a list of commands or how to use you: call the "help" function.
4. Never invent tools or parameters. Use only the exact names & JSON schema provided.
5. If required parameters are missing or ambiguous in the comment, DO NOT guess. Return a clarification message (no tool call).
6. Return at most one tool call. parallel_tool_calls is false.
7. If multiple intents are present, pick the highest‑priority actionable one only if unambiguous; otherwise ask for clarification (no tool call).
8. If no suitable tool: respond with plain text and ensure tool_calls is EMPTY (omit it entirely by not calling any tool).

### Output Behavior
- To invoke a tool: respond via the tool call mechanism (the API will structure tool_calls). Provide only arguments allowed by that tool's schema.
- To NOT invoke a tool: just produce a concise message (e.g., "I can’t perform that action. Try @UbiquityOS help for available commands.").

### Safety / Validation
- Do not hallucinate permissions or repository changes.
- Do not fabricate parameters or users.
- Prefer *not* calling a tool over an uncertain or speculative mapping.

Follow these rules exactly. If uncertain, DO NOT call a tool.
If you have nothing useful to add to the conversation, don't respond with a comment at all. This is because you are stepping in as a first responder on behalf of the issue author.
`,
                type: "text",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                text: JSON.stringify({
                  repositoryOwner: context.payload.repository.owner.login,
                  repositoryName: context.payload.repository.name,
                  issueNumber: context.payload.issue.number,
                  author: context.payload.comment.user?.login,
                  comment: context.payload.comment.body,
                }),
                type: "text",
              },
            ],
          },
        ],
        temperature: 0.3,
        max_completion_tokens: 1024,
        frequency_penalty: 0,
        presence_penalty: 0,
        tools: commands,
        parallel_tool_calls: false,
        response_format: {
          type: "text",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  })();

  context.logger.debug({ response }, "LLM response");

  if (!response?.choices?.length) {
    return;
  }

  const toolCalls = response.choices[0].message.tool_calls;
  if (!toolCalls?.length) {
    context.logger.warn("No tool call was made.");
    return;
  }

  const toolCall = toolCalls[0];
  if (!toolCall) {
    context.logger.debug("No tool can be called.");
    return;
  }

  const command = {
    name: toolCall.function.name,
    parameters: toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : null,
  };

  if (command.name === "help") {
    await postHelpCommand(context);
    return;
  }

  const pluginWithManifest = pluginsWithManifest.find((o) => o.manifest?.commands?.[command.name] !== undefined);
  if (!pluginWithManifest) {
    context.logger.warn({ command: command.name }, `No plugin found for command`);
    return;
  }

  const plugin = pluginWithManifest.target;
  const settings = pluginWithManifest.settings?.with;

  // call plugin
  const isGithubPluginObject = isGithubPlugin(plugin);
  const stateId = crypto.randomUUID();
  const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, command);

  context.logger.info({ plugin, isGithubPluginObject, command }, "Will attempt to call a plugin to answer the help request.");
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
