import { Env } from "../github/types/env.ts";
import { parseGitHubAppConfig } from "../github/utils/github-app-config.ts";
import { parseAgentConfig, parseAiConfig } from "../github/utils/env-config.ts";
import { GitHubEventHandler } from "../github/github-event-handler.ts";
import { logger as baseLogger } from "../logger/logger.ts";
import { CONFIG_ORG_REPO } from "../github/utils/config.ts";
import { tryGetInstallationIdForOwner } from "../github/utils/marketplace-auth.ts";
import { formatTelegramLinkSnippet, getTelegramLinkIssue, peekTelegramLinkCode, saveTelegramLinkIssue } from "./identity-store.ts";

const CREATE_LINK_ISSUE_ERROR = "Failed to create link issue.";

export type ParsedCommentUrl = Readonly<{
  owner: string;
  repo: string;
  commentId: number;
}>;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatOctokitError(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const message = normalizeOptionalString(error.message);
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  const dataMessage = data ? normalizeOptionalString(data.message) : undefined;
  const docUrl = data ? normalizeOptionalString(data.documentation_url) : undefined;

  const parts: string[] = [];
  const lowerParts = new Set<string>();

  function addPart(value?: string): void {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized) return;
    const lower = normalized.toLowerCase();
    if (lowerParts.has(lower)) return;
    lowerParts.add(lower);
    parts.push(normalized);
  }

  if (dataMessage) addPart(dataMessage);
  if (message) {
    const lowerData = dataMessage?.toLowerCase();
    if (!lowerData || message.toLowerCase() !== lowerData) {
      addPart(message);
    }
  }
  if (docUrl) {
    const hasDocUrl = parts.some((part) => part.includes(docUrl));
    if (!hasDocUrl) addPart(docUrl);
  }

  return parts.length ? parts.join(" ") : null;
}

function parseTelegramBotToken(env: Env, logger: typeof baseLogger): string | null {
  const raw = normalizeOptionalString(env.UOS_TELEGRAM);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    logger.warn({ err: error }, "Invalid UOS_TELEGRAM JSON.");
    return null;
  }
  if (!isRecord(parsed)) {
    logger.warn("Invalid UOS_TELEGRAM config.");
    return null;
  }
  const botToken = normalizeOptionalString(parsed.botToken);
  if (!botToken) {
    logger.warn("UOS_TELEGRAM.botToken is required.");
    return null;
  }
  return botToken;
}

export async function sendTelegramLinkConfirmation(params: { env: Env; userId: number; owner: string; logger: typeof baseLogger }): Promise<void> {
  const botToken = parseTelegramBotToken(params.env, params.logger);
  if (!botToken) return;
  const text = `Linked to ${params.owner}. You're all set.`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.userId,
        text,
        disable_web_page_preview: true,
        disable_notification: true,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to send Telegram link confirmation");
    }
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to send Telegram link confirmation");
  }
}

export async function sendTelegramLinkFailure(params: { env: Env; userId: number; owner: string; error: string; logger: typeof baseLogger }): Promise<void> {
  const botToken = parseTelegramBotToken(params.env, params.logger);
  if (!botToken) return;
  const errorText = params.error.trim() || "Unknown error";
  const text = `Linking to ${params.owner} failed.\n\n${errorText}\n\nRestart linking with /status.`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: params.userId,
        text,
        disable_web_page_preview: true,
        disable_notification: true,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      params.logger.warn({ status: response.status, detail }, "Failed to send Telegram link failure notification");
    }
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to send Telegram link failure notification");
  }
}

async function createLinkEventHandler(params: {
  env: Env;
  logger: typeof baseLogger;
  requestUrl: string;
}): Promise<{ ok: true; eventHandler: GitHubEventHandler } | { ok: false; error: string }> {
  const githubConfigResult = parseGitHubAppConfig(params.env);
  if (!githubConfigResult.ok) {
    return { ok: false, error: githubConfigResult.error };
  }
  const aiConfigResult = parseAiConfig(params.env.UOS_AI);
  if (!aiConfigResult.ok) {
    return { ok: false, error: aiConfigResult.error };
  }
  const agentConfigResult = parseAgentConfig(params.env.UOS_AGENT);
  if (!agentConfigResult.ok) {
    return { ok: false, error: agentConfigResult.error };
  }

  const kernelRefreshUrl = new URL("/internal/agent/refresh-token", params.requestUrl).toString();
  const eventHandler = new GitHubEventHandler({
    environment: params.env.ENVIRONMENT,
    webhookSecret: githubConfigResult.config.webhookSecret,
    appId: githubConfigResult.config.appId,
    privateKey: githubConfigResult.config.privateKey,
    llm: "gpt-5.3-chat-latest",
    aiBaseUrl: aiConfigResult.config.baseUrl,
    aiToken: aiConfigResult.config.token,
    kernelRefreshUrl,
    agent: {
      owner: agentConfigResult.config.owner,
      repo: agentConfigResult.config.repo,
      workflowId: agentConfigResult.config.workflow,
      ref: agentConfigResult.config.ref,
    },
    logger: params.logger,
  });

  return { ok: true, eventHandler };
}

async function getInstallationOctokit(params: {
  env: Env;
  owner: string;
  repo: string;
  logger: typeof baseLogger;
  requestUrl: string;
}): Promise<{ ok: true; octokit: ReturnType<GitHubEventHandler["getAuthenticatedOctokit"]>; installationId: number } | { ok: false; error: string }> {
  const handlerResult = await createLinkEventHandler(params);
  if (!handlerResult.ok) {
    return { ok: false, error: handlerResult.error };
  }
  const { installationId, ownerInstallationId } = await resolveInstallationIds(handlerResult.eventHandler, params.owner, params.repo, params.logger);
  if (!installationId) {
    const base = `No GitHub App installation found for ${params.owner}/${params.repo}.`;
    if (ownerInstallationId) {
      return {
        ok: false,
        error: [
          base,
          `The app appears to be installed on ${params.owner}, but it cannot access ${params.owner}/${params.repo} yet.`,
          `Create ${params.owner}/${params.repo} and ensure the app is installed on it (or grant access to it), then try again.`,
        ].join("\n"),
      };
    }
    return {
      ok: false,
      error: [base, `Install the UbiquityOS GitHub App on ${params.owner}, then try again.`].join("\n"),
    };
  }
  return { ok: true, octokit: handlerResult.eventHandler.getAuthenticatedOctokit(installationId), installationId };
}

export function parseTelegramLinkCommentUrl(raw: string): ParsedCommentUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return null;

  const hash = parsed.hash ?? "";
  const hashMatch = hash.match(/issuecomment-(\d+)/i);
  if (hashMatch?.[1]) {
    const commentId = Number.parseInt(hashMatch[1], 10);
    if (Number.isFinite(commentId)) {
      return { owner, repo, commentId };
    }
  }

  const commentIndex = parts.findIndex((part) => part === "comments");
  if (commentIndex >= 0 && parts[commentIndex + 1]) {
    const commentId = Number.parseInt(parts[commentIndex + 1], 10);
    if (Number.isFinite(commentId)) {
      return { owner, repo, commentId };
    }
  }

  return null;
}

export async function initiateTelegramLinkIssue(params: {
  env: Env;
  code: string;
  owner: string;
  logger: typeof baseLogger;
  requestUrl: string;
}): Promise<{ ok: true; issueUrl: string; issueNumber: number } | { ok: false; error: string }> {
  const code = normalizeOptionalString(params.code);
  const owner = normalizeOptionalString(params.owner);
  if (!code || !owner) {
    return { ok: false, error: "code and owner are required." };
  }

  const peekResult = await peekTelegramLinkCode({ code, logger: params.logger });
  if (!peekResult.ok) {
    return { ok: false, error: peekResult.error };
  }

  const existingIssue = await getTelegramLinkIssue({ code, logger: params.logger });
  if (existingIssue.ok && existingIssue.issue) {
    if (existingIssue.issue.owner.toLowerCase() !== owner.toLowerCase()) {
      return { ok: false, error: "Link code already claimed for a different owner." };
    }
    return { ok: true, issueUrl: existingIssue.issue.issueUrl, issueNumber: existingIssue.issue.issueNumber };
  }

  const octokitResult = await getInstallationOctokit({
    env: params.env,
    owner,
    repo: CONFIG_ORG_REPO,
    logger: params.logger,
    requestUrl: params.requestUrl,
  });
  if (!octokitResult.ok) {
    return { ok: false, error: octokitResult.error };
  }

  const snippet = formatTelegramLinkSnippet(code);
  const expiresInMinutes = Math.max(Math.round((peekResult.expiresAtMs - Date.now()) / 60000), 1);
  const body = [
    "Linking Telegram to GitHub.",
    "",
    "Close this issue to approve linking for this owner.",
    "",
    `Code: ${snippet}`,
    "",
    `This link code expires in ~${expiresInMinutes} minutes.`,
  ].join("\n");

  let issueUrl = "";
  let issueNumber = 0;
  try {
    const response = await octokitResult.octokit.rest.issues.create({
      owner,
      repo: CONFIG_ORG_REPO,
      title: "Link Telegram identity",
      body,
    });
    issueUrl = response.data.html_url ?? "";
    issueNumber = response.data.number ?? 0;
  } catch (error) {
    params.logger.warn({ err: error, owner }, "Failed to create link issue.");
    const details = formatOctokitError(error);
    return { ok: false, error: details ?? CREATE_LINK_ISSUE_ERROR };
  }

  if (!issueUrl || !issueNumber) {
    return { ok: false, error: CREATE_LINK_ISSUE_ERROR };
  }

  const saveIssue = await saveTelegramLinkIssue({
    code,
    issue: {
      owner,
      repo: CONFIG_ORG_REPO,
      issueNumber,
      issueUrl,
      createdAtMs: Date.now(),
    },
    expiresAtMs: peekResult.expiresAtMs,
    logger: params.logger,
  });
  if (!saveIssue.ok) {
    return { ok: false, error: saveIssue.error };
  }

  return { ok: true, issueUrl, issueNumber };
}

async function resolveInstallationId(eventHandler: GitHubEventHandler, owner: string, repo: string, logger: typeof baseLogger): Promise<number | null> {
  try {
    const appOctokit = eventHandler.getUnauthenticatedOctokit();
    const { data } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
    if (typeof data?.id === "number") return data.id;
  } catch (error) {
    logger.warn({ err: error, owner, repo }, "Failed to resolve GitHub App installation for linking");
  }
  return null;
}

async function resolveInstallationIds(
  eventHandler: GitHubEventHandler,
  owner: string,
  repo: string,
  logger: typeof baseLogger
): Promise<Readonly<{ installationId: number | null; ownerInstallationId: number | null }>> {
  const installationId = await resolveInstallationId(eventHandler, owner, repo, logger);
  let ownerInstallationId: number | null = null;
  try {
    ownerInstallationId = await tryGetInstallationIdForOwner(eventHandler, owner);
  } catch (error) {
    logger.warn({ err: error, owner }, "Failed to resolve owner GitHub App installation while linking (non-fatal)");
  }

  return { installationId, ownerInstallationId };
}
