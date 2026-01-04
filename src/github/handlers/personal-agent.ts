import { tokenOctokit } from "../github-client";
import { GitHubContext } from "../github-context";
import { PluginInput } from "../types/plugin";
import { updateRequestCommentRunUrl } from "../utils/request-comment-run-url";

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) return responseStatus;
  return null;
}

function getEnvValue(key: string): string | null {
  if (typeof process !== "undefined" && process.env) {
    const value = process.env[key];
    if (value) return value;
  }
  const deno = (globalThis as { Deno?: { env?: { get?: (name: string) => string | undefined } } }).Deno;
  if (deno?.env?.get) {
    try {
      const value = deno.env.get(key);
      if (value) return value;
    } catch {
      return null;
    }
  }
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
    const patToken = getEnvValue("UOS_PERSONAL_AGENT_PAT")?.trim();
    if (!patToken) {
      logger.error({ owner, repo, commentId, personalAgentOwner }, "Missing UOS_PERSONAL_AGENT_PAT; cannot dispatch personal agent");
      throw new Error("Missing UOS_PERSONAL_AGENT_PAT");
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

    const octokit = createTokenOctokit(context, patToken);
    const defaultBranch = await getDefaultBranchWithToken(octokit, personalAgentOwner, personalAgentRepo);
    const pluginInput = new PluginInput(context.eventHandler, crypto.randomUUID(), context.key, context.payload, {}, patToken, defaultBranch, null);

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
