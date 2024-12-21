import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { postHelpCommand } from "./help-command";

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim().toLowerCase();
  if (body.startsWith(`/help`)) {
    await postHelpCommand(context);
  } else if (body.startsWith(`@ubiquityos`)) {
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
    console.log(`No installation found, cannot invoke command`);
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
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: [
          {
            text: `
You are a GitHub bot named **UbiquityOS**. Your role is to interpret and execute commands based on user comments provided in structured JSON format.

### JSON Structure:
The input will include the following fields:
- repositoryOwner: The username of the repository owner.
- repositoryName: The name of the repository where the comment was made.
- issueNumber: The issue or pull request number where the comment appears.
- author: The username of the user who posted the comment.
- comment: The comment text directed at UbiquityOS.

### Example JSON:
{
  "repositoryOwner": "repoOwnerUsername",
  "repositoryName": "example-repo",
  "issueNumber": 42,
  "author": "user1",
  "comment": "@UbiquityOS please allow @user2 to change priority and time labels."
}

### Instructions:
- **Interpretation Mode**:
  - **Tagged Natural Language**: Interpret the "comment" field provided in JSON. Users will mention you with "@UbiquityOS", followed by their request. Infer the intended command and parameters based on the "comment" content.

- **Action**: Map the user's intent to one of your available functions. When responding, use the "author", "repositoryOwner", "repositoryName", and "issueNumber" fields as context if relevant.
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
    temperature: 1,
    max_tokens: 2048,
    top_p: 1,
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
    console.log("No tool call");
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
      await dispatchWorker(plugin, await inputs.getWorkerInputs());
    } else {
      await dispatchWorkflow(context, {
        owner: plugin.owner,
        repository: plugin.repo,
        workflowId: plugin.workflowId,
        ref: ref,
        inputs: await inputs.getWorkflowInputs(),
      });
    }
  } catch (e) {
    console.error(`An error occurred while processing the plugin chain, will skip plugin ${JSON.stringify(plugin)}`, e);
  }
}
