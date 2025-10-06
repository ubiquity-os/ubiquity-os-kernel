import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { dispatchWorkflow, getDefaultBranch } from "../utils/workflow-dispatch";

export async function callPersonalAgent(context: GitHubContext<"issue_comment.created">) {
  const { logger, payload } = context;

  const owner = payload.repository.owner.login;
  const body = payload.comment.body.trim();

  if (!body.trim().startsWith("@")) {
    logger.info(`Ignoring irrelevant comment: ${body}`);
    return;
  }

  const targetUser = /^\s*@([a-z0-9-_]+)/i.exec(body);
  if (!targetUser) {
    logger.error(`Missing target username from comment: ${body}`);
    return;
  }

  const personalAgentOwner = targetUser[1];
  const personalAgentRepo = "personal-agent";
  logger.info({ owner, personalAgentOwner, comment: body }, `Comment received`);

  try {
    const defaultBranch = await getDefaultBranch(context, personalAgentOwner, personalAgentRepo);

    const pluginInput = new PluginInput(context.eventHandler, crypto.randomUUID(), context.key, context.payload, {}, "dummy-token", defaultBranch, null);

    await dispatchWorkflow(context, {
      owner: personalAgentOwner,
      repository: personalAgentRepo,
      workflowId: "compute.yml",
      ref: defaultBranch,
      inputs: await pluginInput.getInputs(),
    });
  } catch (error) {
    logger.error(`Error dispatching personal-agent workflow: ${error}`);
    return;
  }

  logger.info(`Successfully sent the comment to ${personalAgentOwner}/${personalAgentRepo}`);
}
