import { customOctokit } from "../github-client";
import { GitHubContext } from "../github-context";

interface WorkflowDispatchOptions {
  owner: string;
  repository: string;
  workflowId: string;
  ref?: string;
  inputs?: { [key: string]: string };
}

function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getInstallationOctokitForRepo(context: GitHubContext, owner: string, repository: string): Promise<InstanceType<typeof customOctokit>> {
  const installation = await context.octokit.rest.apps.getRepoInstallation({
    owner,
    repo: repository,
  });

  if (!installation.data.id) {
    throw new Error(`No installation found for repo: ${owner}/${repository}`);
  }

  return context.eventHandler.getAuthenticatedOctokit(installation.data.id);
}

async function getDefaultBranchWithOctokit(octokit: InstanceType<typeof customOctokit>, owner: string, repository: string) {
  const repo = await octokit.rest.repos.get({
    owner,
    repo: repository,
  });
  return repo.data.default_branch;
}

function looksLikeWorkflowFileName(workflowId: string): boolean {
  const lower = workflowId.toLowerCase();
  return lower.endsWith(".yml") || lower.endsWith(".yaml");
}

async function workflowFileExistsOnRef(
  octokit: InstanceType<typeof customOctokit>,
  owner: string,
  repository: string,
  workflowId: string,
  ref: string
): Promise<boolean> {
  const path = `.github/workflows/${workflowId}`;
  try {
    await octokit.rest.repos.getContent({ owner, repo: repository, path, ref });
    return true;
  } catch (error) {
    const status = getHttpStatus(error);
    if (status === 404) return false;
    throw error;
  }
}

export async function dispatchWorkflow(context: GitHubContext, options: WorkflowDispatchOptions) {
  const authenticatedOctokit = await getInstallationOctokitForRepo(context, options.owner, options.repository);

  const defaultBranch = await getDefaultBranchWithOctokit(authenticatedOctokit, options.owner, options.repository);
  const ref = options.ref ?? defaultBranch;

  const retryDelayMs = 10_000;
  const maxRetryMs = 2 * 60_000;
  const startedAt = Date.now();
  let attempt = 0;
  let hasValidatedDefaultBranchWorkflow = false;
  // Newly-created repos can temporarily return 404 for workflow dispatch even when the file exists, due to Actions indexing lag.
  // Use a small linear polling retry to smooth over those first-invocation failures.
  while (true) {
    attempt++;
    try {
      return await authenticatedOctokit.rest.actions.createWorkflowDispatch({
        owner: options.owner,
        repo: options.repository,
        workflow_id: options.workflowId,
        ref,
        inputs: options.inputs,
      });
    } catch (error) {
      const status = getHttpStatus(error);
      if (status !== 404) throw error;

      if (!hasValidatedDefaultBranchWorkflow && looksLikeWorkflowFileName(options.workflowId)) {
        hasValidatedDefaultBranchWorkflow = true;
        const hasWorkflowOnDefaultBranch = await workflowFileExistsOnRef(
          authenticatedOctokit,
          options.owner,
          options.repository,
          options.workflowId,
          defaultBranch
        );
        if (!hasWorkflowOnDefaultBranch) {
          throw new Error(
            `Workflow "${options.workflowId}" not found on default branch "${defaultBranch}" for ${options.owner}/${options.repository}; GitHub requires workflow_dispatch workflows to exist on the default branch`
          );
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxRetryMs) throw error;

      context.logger.warn(
        {
          owner: options.owner,
          repository: options.repository,
          workflowId: options.workflowId,
          ref,
          defaultBranch,
          attempt,
          elapsedMs,
        },
        "Workflow dispatch returned 404; retrying (workflow may not be indexed yet)"
      );

      const remainingMs = maxRetryMs - elapsedMs;
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
}

export async function dispatchWorker(targetUrl: string, payload?: Record<string, unknown>) {
  const { signature, ...body } = payload || {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (signature) {
    headers["X-Hub-Signature-256"] = `sha256=${signature}`;
  }

  const result = await fetch(targetUrl, {
    body: JSON.stringify(body),
    method: "POST",
    headers,
  });

  if (!result.ok) {
    const errText = await result.text();
    throw new Error(`HTTP ${result.status}: ${errText}`);
  }

  return result.json();
}

export async function getDefaultBranch(context: GitHubContext, owner: string, repository: string) {
  const octokit = await getInstallationOctokitForRepo(context, owner, repository); // we cannot access other repos with the context's octokit
  return await getDefaultBranchWithOctokit(octokit, owner, repository);
}
