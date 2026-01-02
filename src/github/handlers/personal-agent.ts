import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { dispatchWorkflowWithRunUrl, getDefaultBranch } from "../utils/workflow-dispatch";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url";

export async function callPersonalAgent(context: GitHubContext<"issue_comment.created">) {
  const { logger, payload } = context;

  const owner = payload.repository.owner.login;
  const body = payload.comment.body.trim();
  const installationId = "installation" in payload ? payload.installation?.id : undefined;

  if (!body.startsWith("@")) {
    logger.debug(`Ignoring irrelevant comment: ${body}`);
    return;
  }

  const targetUser = /^\s*@([a-z0-9-_]+)/i.exec(body);
  if (!targetUser) {
    logger.error(`Missing target username from comment: ${body}`);
    return;
  }

  const personalAgentOwner = targetUser[1];
  const personalAgentRepo = "personal-agent";
  logger.debug({ owner, personalAgentOwner, comment: body }, `Comment received`);

  try {
    if (!installationId) {
      logger.warn("No installation found, cannot dispatch personal agent");
      return;
    }
    const defaultBranch = await getDefaultBranch(context, personalAgentOwner, personalAgentRepo);
    const token = await context.eventHandler.getToken(installationId);
    const pluginInput = new PluginInput(context.eventHandler, crypto.randomUUID(), context.key, context.payload, {}, token, defaultBranch, null);

    const runUrl = await dispatchWorkflowWithRunUrl(context, {
      owner: personalAgentOwner,
      repository: personalAgentRepo,
      workflowId: "compute.yml",
      ref: defaultBranch,
      inputs: await pluginInput.getInputs(),
    });
    await updateRequestCommentRunUrl(context, runUrl);
  } catch (error) {
    logger.error(`Error dispatching personal-agent workflow: ${error}`);
    return;
  }

  logger.info(`Successfully sent the comment to ${personalAgentOwner}/${personalAgentRepo}`);
}
