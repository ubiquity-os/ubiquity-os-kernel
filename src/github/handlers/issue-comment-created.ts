import { Manifest } from "../../types/manifest";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { isGithubPlugin, PluginConfiguration } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { dispatchWorker, dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";
import { postHelpCommand } from "./help-command";

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim().toLowerCase();
  if (body.startsWith(`@ubiquityos`) || body.startsWith(`/`)) {
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
      },
    },
  },
  {
    type: "function",
    function: {
      name: "allow",
      strict: false,
      parameters: {
        type: "object",
        required: ["username", "label_types"],
        properties: {
          username: {
            type: "string",
            description: "the user that will be allowed to change the label",
          },
          label_types: {
            type: "array",
            items: {
              enum: ["time", "priority"],
              type: "string",
            },
            description: "array of label types that user will be allowed to change, it can be empty to remove access from all labels",
          },
        },
        additionalProperties: false,
      },
      description: "Sets which label types can the user change",
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
    const { uses } = config.plugins[i];
    for (let j = 0; j < uses.length; ++j) {
      const { plugin } = uses[j];
      const manifest = await getManifest(context, plugin);
      if (!manifest?.commands) {
        continue;
      }
      pluginsWithManifest.push({
        plugin: uses[j],
        manifest,
      });
      for (const command of manifest.commands) {
        commands.push({
          type: "function",
          function: {
            ...command,
            strict: true,
          },
        });
      }
    }
  }

  const response = await context.openAi.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: [
          {
            text: `You are a GitHub bot named **UbiquityOS**. Your role is to interpret and execute commands based on user comments.

### Instructions:
- **Interpretation Modes**:
  1. **Tagged Natural Language**: The user mentions you with \`@UbiquityOS\`, asking for an action or information. Infer the intended command and parameters.
     - Example: \`@UbiquityOS, please allow @user to change priority and time labels.\`
  2. **Direct Command**: The user starts the comment with a command in \`/command\` format.
     - Example: \`/allow @user priority time\`

- **Action**: Map the user's intent to one of your available functions. If no matching function is found, respond that no appropriate command was identified.`,
            type: "text",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            text: context.payload.comment.body,
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
  if (!toolCalls || toolCalls.length === 0) {
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

  const pluginWithManifest = pluginsWithManifest.find((o) => o.manifest?.commands?.some((c) => c.name === command.name));
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
        ref: plugin.ref,
        inputs: await inputs.getWorkflowInputs(),
      });
    }
  } catch (e) {
    console.error(`An error occurred while processing the plugin chain, will skip plugin ${JSON.stringify(plugin)}`, e);
  }
}
