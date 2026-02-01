import { GitHubContext } from "../github-context.ts";
import { Env } from "../types/env.ts";
import {
  clearTelegramLinkPending,
  consumeTelegramLinkCode,
  deleteTelegramLinkIssue,
  getTelegramLinkCodeForIssue,
  saveTelegramLinkedIdentity,
} from "../../telegram/identity-store.ts";
import { sendTelegramLinkConfirmation } from "../../telegram/link.ts";

type IssueClosedPayload = {
  repository?: { name?: string; owner?: { login?: string; type?: string } };
  issue?: { number?: number; state?: string; closed_by?: { login?: string } };
  sender?: { login?: string };
};

type IssueClosedDetails = {
  owner: string;
  repo: string;
  issueNumber: number;
  closerLogin: string;
  ownerType?: string;
};

function parseIssueClosedDetails(payload: IssueClosedPayload): IssueClosedDetails | null {
  const owner = payload.repository?.owner?.login ?? "";
  const repo = payload.repository?.name ?? "";
  const issueNumber = payload.issue?.number ?? 0;
  const closerLogin = payload.sender?.login ?? payload.issue?.closed_by?.login ?? "";
  const ownerType = payload.repository?.owner?.type;
  if (!owner || !repo || !issueNumber || !closerLogin) return null;
  return { owner, repo, issueNumber, closerLogin, ownerType };
}

async function isOrgOwner(context: GitHubContext, owner: string, ownerType?: string): Promise<boolean> {
  if (typeof ownerType === "string") {
    return ownerType.toLowerCase() === "organization";
  }
  try {
    const { data } = await context.octokit.rest.orgs.get({ org: owner });
    return typeof data?.type === "string" && data.type.toLowerCase() === "organization";
  } catch {
    return false;
  }
}

async function isOrgMember(context: GitHubContext, org: string, username: string): Promise<boolean> {
  try {
    const response = await context.octokit.rest.orgs.checkMembershipForUser({ org, username });
    return response.status === 204;
  } catch {
    return false;
  }
}

export async function handleTelegramLinkIssueClosed(context: GitHubContext<"issues.closed">, env: Env): Promise<void> {
  const payload = context.payload as IssueClosedPayload;
  const details = parseIssueClosedDetails(payload);
  if (!details) return;

  const linkCodeResult = await getTelegramLinkCodeForIssue({
    owner: details.owner,
    repo: details.repo,
    issueNumber: details.issueNumber,
    logger: context.logger,
  });
  if (!linkCodeResult.ok || !linkCodeResult.code) return;

  const isOwnerOrg = await isOrgOwner(context, details.owner, details.ownerType);
  const isAllowed = isOwnerOrg
    ? await isOrgMember(context, details.owner, details.closerLogin)
    : details.closerLogin.toLowerCase() === details.owner.toLowerCase();
  if (!isAllowed) return;

  const consumeResult = await consumeTelegramLinkCode({ code: linkCodeResult.code, logger: context.logger });
  if (!consumeResult.ok) return;

  const saveResult = await saveTelegramLinkedIdentity({
    userId: consumeResult.userId,
    owner: details.owner,
    ownerType: isOwnerOrg ? "org" : "user",
    logger: context.logger,
  });
  if (!saveResult.ok) return;

  await clearTelegramLinkPending({ userId: consumeResult.userId, logger: context.logger });
  await deleteTelegramLinkIssue({ code: linkCodeResult.code, logger: context.logger });
  await sendTelegramLinkConfirmation({
    env,
    userId: consumeResult.userId,
    owner: details.owner,
    logger: context.logger,
  });
}
