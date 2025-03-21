import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { Example, findSimilarExamples, initializeExamples } from "../utils/examples";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { postHelpCommand } from "./help-command";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { retry } from "../utils/retry";
import { parseToolCall } from "../utils/tool-parser";

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim().toLowerCase();

  if (body.startsWith(`/help`)) {
    await postHelpCommand(context);
  } else if (body.startsWith(`@ubiquityos`)) {
    await commandRouter(context);
  }
}

const embeddedCommands: Array<ChatCompletionTool> = [
  {
    type: "function",
    function: {
      name: "help",
      description: "Shows all available commands and their examples",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

async function buildPrompt(
  context: GitHubContext<"issue_comment.created">,
  commands: Array<ChatCompletionTool>,
  manifests: Manifest[],
  similarExamples: string[]
) {
  // Gather command descriptions and examples
  const availableCommands = commands.map((cmd) => ({
    name: cmd.function.name,
    description: cmd.function.description || "",
    parameters: cmd.function.parameters,
  }));

  // Find matching examples and their command info from manifests
  const detailedExamples = manifests.flatMap((manifest) => {
    if (!manifest.commands) return [];

    return Object.entries(manifest.commands).flatMap(([commandName, command]) => {
      // Get all matching examples for this command
      const allExamples = [];

      // Add ubiquity:example first if it exists
      if (command["ubiquity:example"]) {
        allExamples.push({
          commandInvocation: command["ubiquity:example"],
          commandName,
          description: command.description,
          expectedToolCallResult: {
            function: commandName,
            parameters: command.parameters || {},
          },
        });
      }

      // Add any matching examples from the similar examples list
      const matchingExamples = command.examples?.filter((example) => similarExamples.includes(example.commandInvocation)) ?? [];

      allExamples.push(
        ...matchingExamples.map((ex) => ({
          ...ex,
          commandName,
          description: command.description,
        }))
      );

      return allExamples;
    });
  });

  // Format matched examples with their command info
  const examplesSection = detailedExamples
    .map((example) => {
      const descriptionLine = example.description ? `Description: ${example.description}` : "";
      return `Example: ${example.commandInvocation}
Command: ${example.commandName}
${descriptionLine}
Tool Call:
{
  "function": "${example.expectedToolCallResult.function}",
  "parameters": ${JSON.stringify(example.expectedToolCallResult.parameters, null, 2)}
}`;
    })
    .join("\n\n");

  // Format available commands section
  const commandsSection = availableCommands
    .map((cmd) => {
      const commandDesc = cmd.description ? ` - ${cmd.description}` : "";
      return `${cmd.name}${commandDesc}
Parameters: ${JSON.stringify(cmd.parameters || {}, null, 2)}`;
    })
    .join("\n\n");

  const systemMessage = `You are UbiquityOS, a GitHub bot that executes commands through function calls.

Available Commands:
${commandsSection}

Similar Command Examples:
${examplesSection}

Input Format:
{
  "repositoryOwner": "string", // Repository owner's username
  "repositoryName": "string",  // Repository name
  "issueNumber": "number",     // Issue or PR number
  "author": "string",         // Comment author's username
  "comment": "string"         // The command text
}

Guidelines:
1. Users invoke you with "@UbiquityOS" + command text
2. Extract parameters from natural language
3. Return tool call matching closest example
4. Use relevant context from input JSON`;

  const userContent = JSON.stringify(
    {
      repositoryOwner: context.payload.repository.owner.login,
      repositoryName: context.payload.repository.name,
      issueNumber: context.payload.issue.number,
      author: context.payload.comment.user?.login,
      comment: context.payload.comment.body,
    },
    null,
    2
  );

  return {
    model: "openai/o3-mini",
    messages: [
      {
        role: "system" as const,
        content: systemMessage,
      },
      {
        role: "user" as const,
        content: userContent,
      },
    ],
    temperature: 1,
    max_tokens: 2048,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    tools: commands,
    parallel_tool_calls: false,
  };
}

async function commandRouter(context: GitHubContext<"issue_comment.created">) {
  if (!("installation" in context.payload) || context.payload.installation?.id === undefined) {
    console.log(`No installation found, cannot invoke command`);
    return;
  }

  const commands = [...embeddedCommands];
  const config = await getConfig(context);
  const pluginsWithManifest: { plugin: PluginConfiguration["plugins"][0]["uses"][0]; manifest: Manifest }[] = [];

  let examples: Example[] = [];
  for (let i = 0; i < config.plugins.length; ++i) {
    const plugin = config.plugins[i].uses[0];

    const manifest = await getManifest(context, plugin.plugin);
    if (!manifest?.commands) {
      continue;
    }
    examples = [...examples, ...(await initializeExamples(manifest, context.voyageAiClient))];

    pluginsWithManifest.push({
      plugin: plugin,
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
                required: Object.keys(command.parameters.properties),
                additionalProperties: false,
              }
            : undefined,
        },
      });
    }
  }

  // Get similar examples for the current input
  const similarExamples = await findSimilarExamples(context.voyageAiClient, context.payload.comment.body.trim(), examples);

  const promptConfig = await buildPrompt(
    context,
    commands,
    pluginsWithManifest.map((plugin) => plugin.manifest),
    similarExamples
  );

  let currentErrorContext: string | undefined;
  const response = await retry(
    async () => {
      const config = {
        ...promptConfig,
        messages: [
          ...promptConfig.messages,
          ...(currentErrorContext
            ? [
                {
                  role: "system" as const,
                  content: `Previous attempt failed: ${currentErrorContext}. Please provide a valid tool call.`,
                },
              ]
            : []),
        ],
      };

      const response = await context.openAi.chat.completions.create(config);
      if (!response.choices.length) {
        throw new Error("No choices returned from OpenAI");
      }

      const result = parseToolCall(response, commands);
      if (result === null) {
        // Valid no-tool-call response
        return {
          type: "content" as const,
          message: response.choices[0].message.content || "I cannot help with that.",
        };
      }

      if ("error" in result) {
        currentErrorContext = result.error;
        throw new Error(result.error);
      }

      return {
        type: "tool" as const,
        command: result,
      };
    },
    {
      maxRetries: 3,
      onError: (error: unknown) => console.error("OpenAI call failed:", error),
    }
  ).catch(() => ({
    type: "error" as const,
    message: "I apologize, but I encountered an error processing your command. Please try again.",
  }));

  // Post response or process command all at once at the end
  if (response.type === "content" || response.type === "error") {
    await context.octokit.rest.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: response.message,
    });
    return;
  }

  if (response.command.name === "help") {
    await postHelpCommand(context);
    return;
  }

  const { command } = response;

  const pluginWithManifest = pluginsWithManifest.find((o) => o.manifest?.commands?.[command.name] !== undefined);
  if (!pluginWithManifest) {
    console.log(`No plugin found for command '${command.name}'`);
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
    console.error(`An error occurred while processing the plugin chain, will skip plugin ${JSON.stringify(plugin)}`, e);
  }
}
