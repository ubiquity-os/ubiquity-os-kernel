import { tokenOctokit } from "../github-client.ts";
import { GitHubContext } from "../github-context.ts";
import { PluginInput } from "../types/plugin.ts";
import { getLeadingMention } from "../utils/mention.ts";
import { toOctokitLogMeta } from "../utils/octokit-log.ts";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url.ts";

type TokenOctokitLike = {
  rest: {
    repos: {
      get: (args: { owner: string; repo: string }) => Promise<{ data: { default_branch: string } }>;
    };
    actions: {
      createWorkflowDispatch: (args: { owner: string; repo: string; workflow_id: string; ref: string; inputs: Record<string, string> }) => Promise<unknown>;
    };
  };
};

type PersonalAgentDeps = Readonly<{
  getInstallationTokenForRepo: typeof getInstallationTokenForRepo;
  createTokenOctokit: (context: GitHubContext, token: string) => TokenOctokitLike;
  getDefaultBranchWithToken: (octokit: TokenOctokitLike, owner: string, repository: string) => Promise<string>;
  buildWorkflowDispatchInputs: (params: {
    context: GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">;
    installationToken: string;
    defaultBranch: string;
  }) => Promise<Record<string, string>>;
  updateRequestCommentRunUrl: typeof updateRequestCommentRunUrl;
}>;

function resolvePersonalAgentDeps(deps?: Partial<PersonalAgentDeps>): PersonalAgentDeps {
  return {
    getInstallationTokenForRepo,
    createTokenOctokit,
    getDefaultBranchWithToken: async (octokit, owner, repository) => {
      const repo = await octokit.rest.repos.get({ owner, repo: repository });
      return repo.data.default_branch;
    },
    buildWorkflowDispatchInputs: async ({ context, installationToken, defaultBranch }) => {
      const pluginInput = new PluginInput(context.eventHandler, crypto.randomUUID(), context.key, context.payload, {}, installationToken, defaultBranch, null);
      return await pluginInput.getInputs();
    },
    updateRequestCommentRunUrl,
    ...deps,
  };
}

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

export async function callPersonalAgent(
  context: GitHubContext<"issue_comment.created" | "pull_request_review_comment.created">,
  deps?: Partial<PersonalAgentDeps>
): Promise<boolean> {
  const resolvedDeps = resolvePersonalAgentDeps(deps);
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
    const installationToken = await resolvedDeps.getInstallationTokenForRepo(context, personalAgentOwner, personalAgentRepo);
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

    const octokit = resolvedDeps.createTokenOctokit(context, installationToken);
    const defaultBranch = await resolvedDeps.getDefaultBranchWithToken(octokit, personalAgentOwner, personalAgentRepo);

    await octokit.rest.actions.createWorkflowDispatch({
      owner: personalAgentOwner,
      repo: personalAgentRepo,
      workflow_id: "compute.yml",
      ref: defaultBranch,
      inputs: await resolvedDeps.buildWorkflowDispatchInputs({ context, installationToken, defaultBranch }),
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
    await resolvedDeps.updateRequestCommentRunUrl(context, null);
  } catch (error) {
    logger.warn({ err: error }, "Failed to update request comment run URL");
  }

  return true;
}
