import { tokenOctokit } from "../github-client.ts";
import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { getLeadingMention } from "../utils/mention.ts";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url.ts";
import { toOctokitLogMeta } from "../utils/octokit-log.ts";

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
      debug: (msg: string, info?: unknown) => {
        const meta = toOctokitLogMeta(info);
        context.logger.github(meta ? { info: meta } : {}, msg);
      },
      info: (msg: string, info?: unknown) => {
        const meta = toOctokitLogMeta(info);
        context.logger.github(meta ? { info: meta } : {}, msg);
      },
      warn: (msg: string, info?: unknown) => {
        const meta = toOctokitLogMeta(info);
        context.logger.github(meta ? { info: meta } : {}, msg);
      },
      error: (msg: string, info?: unknown) => {
        const meta = toOctokitLogMeta(info);
        context.logger.github(meta ? { info: meta } : {}, msg);
      },
    },
  });
}

async function getDefaultBranchWithToken(octokit: InstanceType<typeof tokenOctokit>, owner: string, repository: string): Promise<string> {
  const repo = await octokit.rest.repos.get({ owner, repo: repository });
  return repo.data.default_branch;
}

async function getInstallationTokenForRepo(context: GitHubContext, owner: string, repository: string): Promise<string | null> {
  if (typeof context.eventHandler.getUnauthenticatedOctokit !== "function") {
    context.logger.debug({ owner, repo: repository }, "Missing unauthenticated Octokit; cannot check personal-agent installation");
    return null;
  }
  try {
    const appOctokit = context.eventHandler.getUnauthenticatedOctokit();
    const installation = await appOctokit.rest.apps.getRepoInstallation({ owner, repo: repository });
    return await context.eventHandler.getToken(installation.data.id);
  } catch (error) {
    const status = getErrorStatus(error);
    const log = status === 404 ? context.logger.debug : context.logger.warn;
    log(
      {
        err: error,
        owner,
        repo: repository,
        status,
      },
      "Failed to mint installation token for personal-agent repo"
    );
    return null;
  }
}

export async function callPersonalAgent(context: GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">): Promise<boolean> {
  const { logger, payload } = context;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const body = payload.comment.body?.trim() ?? "";
  const commentId = payload.comment.id;
  const leadingMention = getLeadingMention(body);
  if (!leadingMention) return false;
  const personalAgentOwner = leadingMention.toLowerCase();
  if (!personalAgentOwner || personalAgentOwner === "ubiquityos") return false;
  const personalAgentRepo = "personal-agent";

  logger.debug({ owner, personalAgentOwner, comment: body }, "Personal-agent mention received");
  try {
    const installationToken = await getInstallationTokenForRepo(context, personalAgentOwner, personalAgentRepo);
    if (!installationToken) {
      logger.debug({ owner, repo, commentId, personalAgentOwner }, "Personal-agent not registered; skipping");
      return false;
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
    return false;
  }

  try {
    await updateRequestCommentRunUrl(context, null);
  } catch (error) {
    logger.warn({ err: error }, "Failed to update request comment run URL");
  }

  return true;
}
