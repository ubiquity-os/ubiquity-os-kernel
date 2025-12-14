import { customOctokit } from "../github-client";
import { GitHubContext } from "../github-context";

interface WorkflowDispatchOptions {
  owner: string;
  repository: string;
  workflowId: string;
  ref?: string;
  inputs?: { [key: string]: string };
}

async function getInstallationOctokitForOrg(context: GitHubContext, owner: string): Promise<InstanceType<typeof customOctokit>> {
  const installations = await context.octokit.rest.apps.listInstallations();
  const installation = installations.data.find((inst) => inst.account?.login === owner);

  if (!installation) {
    throw new Error(`No installation found for owner: ${owner}`);
  }

  return context.eventHandler.getAuthenticatedOctokit(installation.id);
}

export async function dispatchWorkflow(context: GitHubContext, options: WorkflowDispatchOptions) {
  const authenticatedOctokit = await getInstallationOctokitForOrg(context, options.owner);

  return await authenticatedOctokit.rest.actions.createWorkflowDispatch({
    owner: options.owner,
    repo: options.repository,
    workflow_id: options.workflowId,
    ref: options.ref ?? (await getDefaultBranch(context, options.owner, options.repository)),
    inputs: options.inputs,
  });
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
  const octokit = await getInstallationOctokitForOrg(context, owner); // we cannot access other repos with the context's octokit
  const repo = await octokit.rest.repos.get({
    owner: owner,
    repo: repository,
  });
  return repo.data.default_branch;
}
