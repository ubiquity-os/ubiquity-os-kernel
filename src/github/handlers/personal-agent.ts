import { tokenOctokit } from "../github-client.ts";
import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url.ts";

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) return responseStatus;
  return null;
}

function createTokenOctokit(context: GitHubContext, token: string) {
  return new tokenOctokit({
    request: {
      fetch: fetch.bind(globalThis),
    },
    auth: token,
    log: {
      debug: (msg: string, info?: unknown) => context.logger.github({ info }, msg),
      info: (msg: string, info?: unknown) => context.logger.github({ info }, msg),
      warn: (msg: string, info?: unknown) => context.logger.github({ info }, msg),
      error: (msg: string, info?: unknown) => context.logger.github({ info }, msg),
    },
  });
}

async function getDefaultBranchWithToken(octokit: InstanceType<typeof tokenOctokit>, owner: string, repository: string): Promise<string> {
  const repo = await octokit.rest.repos.get({ owner, repo: repository });
  return repo.data.default_branch;
}

async function getInstallationTokenForRepo(context: GitHubContext, owner: string, repository: string): Promise<string | null> {
  try {
    const appOctokit = context.eventHandler.getUnauthenticatedOctokit();
    const installation = await appOctokit.rest.apps.getRepoInstallation({ owner, repo: repository });
    return await context.eventHandler.getToken(installation.data.id);
  } catch (error) {
    context.logger.warn(
      {
        err: error,
        owner,
        repo: repository,
        status: getErrorStatus(error),
      },
      "Failed to mint installation token for personal-agent repo"
    );
    return null;
  }
}

export async function callPersonalAgent(context: GitHubContext<"issue_comment.created">) {
  const { logger, payload } = context;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const body = payload.comment.body.trim();
  const commentId = payload.comment.id;

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
    const installationToken = await getInstallationTokenForRepo(context, personalAgentOwner, personalAgentRepo);
    if (!installationToken) {
      logger.error({ owner, repo, commentId, personalAgentOwner }, "Missing installation token; cannot dispatch personal agent");
      return;
    }

    logger.info(
      {
        owner,
        repo,
        targetRepo: `${personalAgentOwner}/${personalAgentRepo}`,
        workflow: "compute.yml",
        commentId,
      },
      "Dispatching personal-agent workflow"
    );

    const octokit = createTokenOctokit(context, installationToken);
    const defaultBranch = await getDefaultBranchWithToken(octokit, personalAgentOwner, personalAgentRepo);
    const pluginInput = new PluginInput(context.eventHandler, crypto.randomUUID(), context.key, context.payload, {}, installationToken, defaultBranch, null);

    await octokit.rest.actions.createWorkflowDispatch({
      owner: personalAgentOwner,
      repo: personalAgentRepo,
      workflow_id: "compute.yml",
      ref: defaultBranch,
      inputs: await pluginInput.getInputs(),
    });
    await updateRequestCommentRunUrl(context, null);
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
