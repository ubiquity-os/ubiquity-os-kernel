import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { dispatchWorkflowWithRunUrl, getDefaultBranch } from "../utils/workflow-dispatch";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url";

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) return responseStatus;
  return null;
}

export async function callPersonalAgent(context: GitHubContext<"issue_comment.created">) {
  const { logger, payload } = context;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const body = payload.comment.body.trim();
  const commentId = payload.comment.id;
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
      logger.warn({ owner, repo, commentId }, "No installation found, cannot dispatch personal agent");
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
    logger.error(
      {
        err: error,
        status: getErrorStatus(error),
        owner,
        repo,
        targetRepo: `${personalAgentOwner}/${personalAgentRepo}`,
        commentId,
      },
      "Error dispatching personal-agent workflow"
    );
    return;
  }

  logger.info(`Successfully sent the comment to ${personalAgentOwner}/${personalAgentRepo}`);
}
