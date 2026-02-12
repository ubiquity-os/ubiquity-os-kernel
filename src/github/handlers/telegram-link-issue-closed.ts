import { GitHubContext } from "../github-context.ts";
import { Env } from "../types/env.ts";
import { Buffer } from "node:buffer";
import {
  clearTelegramLinkPending,
  consumeTelegramLinkCode,
  deleteTelegramLinkIssue,
  getTelegramLinkCodeForIssue,
  peekTelegramLinkCode,
  saveTelegramLinkedIdentity,
} from "../../telegram/identity-store.ts";
import { sendTelegramLinkConfirmation, sendTelegramLinkFailure } from "../../telegram/link.ts";
import { CONFIG_FULL_PATH, CONFIG_ORG_REPO, invalidateConfigDownloadCache } from "../utils/config.ts";

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

function extractTelegramLinkCodeFromIssueBody(body: string): string | null {
  const match = /UOS-TELEGRAM-LINK:([A-Z0-9]{8})/iu.exec(body);
  const code = match?.[1]?.trim().toUpperCase() ?? "";
  return code ? code : null;
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
    await context.octokit.rest.orgs.checkMembershipForUser({ org, username });
    return true;
  } catch {
    return false;
  }
}

function getHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if (!("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

async function ensureTelegramOrgConfigInitialized(params: { context: GitHubContext<"issues.closed">; owner: string }): Promise<void> {
  const owner = params.owner.trim();
  if (!owner) return;

  try {
    await params.context.octokit.rest.repos.getContent({
      owner,
      repo: CONFIG_ORG_REPO,
      path: CONFIG_FULL_PATH,
    });
    return;
  } catch (error) {
    const status = getHttpStatus(error);
    if (status !== 404) {
      params.context.logger.debug(
        { err: error, owner, repo: CONFIG_ORG_REPO, path: CONFIG_FULL_PATH },
        "Failed to read org config while initializing Telegram config (non-fatal)"
      );
      return;
    }
  }

  const config = ["plugins: {}", "channels:", "  telegram:", "    mode: shim", `    owner: ${owner}`, ""].join("\n");
  const content = Buffer.from(config, "utf8").toString("base64");

  let branch = "main";
  try {
    const { data } = await params.context.octokit.rest.repos.get({
      owner,
      repo: CONFIG_ORG_REPO,
    });
    const defaultBranch =
      typeof (data as { default_branch?: unknown })?.default_branch === "string" ? String((data as { default_branch?: unknown }).default_branch).trim() : "";
    if (defaultBranch) branch = defaultBranch;
  } catch (error) {
    params.context.logger.debug({ err: error, owner, repo: CONFIG_ORG_REPO }, "Failed to resolve default branch for Telegram config init (non-fatal)");
  }

  try {
    await params.context.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo: CONFIG_ORG_REPO,
      path: CONFIG_FULL_PATH,
      message: "Initialize UbiquityOS config for Telegram",
      content,
      branch,
    });
  } catch (error) {
    params.context.logger.debug(
      { err: error, owner, repo: CONFIG_ORG_REPO, path: CONFIG_FULL_PATH },
      "Failed to initialize org config for Telegram (non-fatal)"
    );
    return;
  }

  await invalidateConfigDownloadCache(params.context, {
    owner,
    repo: CONFIG_ORG_REPO,
    paths: [CONFIG_FULL_PATH],
  });
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
  let code = linkCodeResult.ok ? linkCodeResult.code : null;

  // Recovery path: if the issue<->code index was lost, parse the code directly from the issue body.
  // This prevents users from getting stuck in "linking" if KV storage was partially unavailable.
  if (!code) {
    try {
      const { data } = await context.octokit.rest.issues.get({
        owner: details.owner,
        repo: details.repo,
        issue_number: details.issueNumber,
      });
      const body = typeof (data as { body?: unknown })?.body === "string" ? String((data as { body?: unknown }).body) : "";
      code = extractTelegramLinkCodeFromIssueBody(body);
    } catch (error) {
      context.logger.debug(
        {
          err: error,
          owner: details.owner,
          repo: details.repo,
          issueNumber: details.issueNumber,
        },
        "Failed to fetch issue body while recovering Telegram link code (non-fatal)"
      );
    }
  }

  if (!code) return;

  const isOwnerOrg = await isOrgOwner(context, details.owner, details.ownerType);
  const isAllowed = isOwnerOrg
    ? await isOrgMember(context, details.owner, details.closerLogin)
    : details.closerLogin.toLowerCase() === details.owner.toLowerCase();
  if (!isAllowed) return;

  const peekResult = await peekTelegramLinkCode({
    code,
    logger: context.logger,
  });
  if (!peekResult.ok) return;

  const saveResult = await saveTelegramLinkedIdentity({
    userId: peekResult.userId,
    owner: details.owner,
    ownerType: isOwnerOrg ? "org" : "user",
    githubLogin: details.closerLogin,
    logger: context.logger,
  });
  if (!saveResult.ok) {
    await clearTelegramLinkPending({
      userId: peekResult.userId,
      logger: context.logger,
    });
    await deleteTelegramLinkIssue({ code, logger: context.logger });
    await sendTelegramLinkFailure({
      env,
      userId: peekResult.userId,
      owner: details.owner,
      error: saveResult.error,
      logger: context.logger,
    });
    return;
  }

  if (details.repo === CONFIG_ORG_REPO) {
    await ensureTelegramOrgConfigInitialized({ context, owner: details.owner });
  }

  await clearTelegramLinkPending({
    userId: peekResult.userId,
    logger: context.logger,
  });
  await deleteTelegramLinkIssue({ code, logger: context.logger });
  await consumeTelegramLinkCode({ code, logger: context.logger });
  await sendTelegramLinkConfirmation({
    env,
    userId: peekResult.userId,
    owner: details.owner,
    logger: context.logger,
  });
}
