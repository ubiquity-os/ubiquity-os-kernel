import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { postHelpCommand } from "./help-command";

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
    const comments = await context.octokit.rest.issues.listComments({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      per_page: 100,
    });

    const currentIndex = comments.data.filter((comment) => comment.user?.type === "User").findIndex((comment) => comment.id === currentCommentId);
    if (currentIndex > 0) {
      return comments.data[currentIndex - 1];
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
  return previousComment?.user?.login !== commentAuthor;
}

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim().toLowerCase();
  if (body.startsWith(`/help`)) {
    await postHelpCommand(context);
  } else if (body.startsWith(`@ubiquityos`)) {
    await commandRouter(context);
  } else if (await isUserHelpRequest(context)) {
    const issueAuthor = context.payload.issue.user?.login;
    context.payload.comment.body = context.payload.comment.body.replace(`@${issueAuthor}`, `@ubiquityos`);
    await commandRouter(context);
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
  const pluginsWithManifest: { plugin: PluginConfiguration["plugins"][0]["uses"][0]; manifest: Manifest }[] = [];
  for (let i = 0; i < config.plugins.length; ++i) {
    const plugin = config.plugins[i].uses[0];

    const manifest = await getManifest(context, plugin.plugin);
    if (!manifest?.commands) {
      continue;
    }
    pluginsWithManifest.push({
      plugin: plugin,
      manifest,
    });
    for (const [name, command] of Object.entries(manifest.commands)) {
      commands.push({
        type: "function",
        function: {
          name: name,
          parameters: command.parameters
            ? {
                ...command.parameters,
                required: Object.keys(command.parameters.properties),
                additionalProperties: false,
              }
            : undefined,
          strict: true,
        },
      });
    }
  }

  const response = await context.openAi.chat.completions.create({
    model: context.llm,
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
    max_tokens: 1024,
    frequency_penalty: 0,
    presence_penalty: 0,
    tools: commands,
    parallel_tool_calls: false,
    response_format: {
      type: "text",
    },
  });

  if (response.choices.length === 0) {
    return;
  }

  context.logger.debug({ response }, "LLM response");

  const toolCalls = response.choices[0].message.tool_calls;
  if (!toolCalls?.length) {
    const message = response.choices[0].message.content || "I cannot help you with that.";
    await context.octokit.rest.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: message,
    });
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
  const {
    plugin: { plugin, with: settings },
  } = pluginWithManifest;

  // call plugin
  const isGithubPluginObject = isGithubPlugin(plugin);
  const stateId = crypto.randomUUID();
  const ref = isGithubPluginObject ? (plugin.ref ?? (await getDefaultBranch(context, plugin.owner, plugin.repo))) : plugin;
  const token = await context.eventHandler.getToken(context.payload.installation.id);
  const inputs = new PluginInput(context.eventHandler, stateId, context.key, context.payload, settings, token, ref, command);

  context.logger.info({ plugin }, "Will attempt to call a plugin to answer the help request.");
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
    context.logger.error({ plugin, err: e }, "An error occurred while processing plugin chain; skipping plugin");
  }
}
