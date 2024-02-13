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
  const installations = await context.octokit.apps.listInstallations();
  const installation = installations.data.find((inst) => inst.account?.login === owner);

  if (!installation) {
    throw new Error(`No installation found for owner: ${owner}`);
  }

  return context.eventHandler.getAuthenticatedOctokit(installation.id);
}

export async function dispatchWorkflow(context: GitHubContext, options: WorkflowDispatchOptions) {
  const authenticatedOctokit = await getInstallationOctokitForOrg(context, options.owner);

  return await authenticatedOctokit.actions.createWorkflowDispatch({
    owner: options.owner,
    repo: options.repository,
    workflow_id: options.workflowId,
    ref: options.ref ?? (await getDefaultBranch(context, options.owner, options.repository)),
    inputs: options.inputs,
  });
}

async function getDefaultBranch(context: GitHubContext, owner: string, repository: string) {
  const repo = await context.octokit.repos.get({
    owner: owner,
    repo: repository,
  });
  return repo.data.default_branch;
}
