import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubContext } from "../github/github-context.ts";
import { buildIssueUrl, type TelegramRoutingConfig, type TelegramRoutingOverride } from "./routing-context.ts";
import { safeSendTelegramMessage, type TelegramReplyMarkup } from "./api-client.ts";
import { clearTelegramLinkPending, getTelegramLinkIssue, getTelegramLinkPending, type TelegramLinkedIdentity } from "./identity-store.ts";
import { buildTelegramIssueKeyboard, buildTelegramLinkingKeyboard } from "./handler-callback.ts";
import { getTelegramKv, saveTelegramRoutingOverride } from "./handler-routing.ts";
import { type Logger, normalizeTelegramUserCommandName, TELEGRAM_START_LINKING_LABEL, type TelegramMessage } from "./handler-shared.ts";
import { normalizeLogin } from "./normalization.ts";
import {
  buildTelegramSessionIssueBody,
  buildTelegramSessionIssueTitle,
  escapeTelegramHtml,
  escapeTelegramHtmlAttribute,
  formatTelegramChatLabel,
  getTelegramAuthor,
} from "./formatting.ts";

type TelegramIssueCreation = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  persisted: boolean;
};

type EnsureTelegramIssueContextResult =
  | {
      ok: true;
      context: GitHubContext<"issue_comment.created">;
      hasIssueContext: true;
      createdIssue?: TelegramIssueCreation;
      routingOverride: TelegramRoutingOverride;
    }
  | {
      ok: false;
      error: string;
    };

export async function ensureTelegramIssueContext(params: {
  context: GitHubContext<"issue_comment.created">;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  updateId: number;
  message: TelegramMessage;
  rawText: string;
  botToken: string;
  chatId: number;
  threadId?: number;
  logger: Logger;
}): Promise<EnsureTelegramIssueContextResult> {
  const owner = params.routing.owner?.trim();
  const repo = params.routing.repo?.trim();
  if (!owner || !repo) {
    return {
      ok: false,
      error: "Missing repo context; set it with /topic <github-repo-url>.",
    };
  }

  const installationId = params.context.payload.installation?.id;
  if (!installationId) {
    return {
      ok: false,
      error: "No GitHub App installation found for Telegram routing.",
    };
  }

  try {
    const telegramAuthor = getTelegramAuthor(params.message);
    const payloadAuthor =
      typeof params.context.payload.comment?.user?.login === "string" && params.context.payload.comment.user.login.trim()
        ? params.context.payload.comment.user.login.trim()
        : telegramAuthor;
    const payloadAssociation =
      typeof params.context.payload.comment?.author_association === "string" && params.context.payload.comment.author_association.trim()
        ? params.context.payload.comment.author_association.trim()
        : "NONE";
    const chatLabel = formatTelegramChatLabel(params.message.chat);
    const title = buildTelegramSessionIssueTitle(telegramAuthor, chatLabel);
    const body = buildTelegramSessionIssueBody({
      author: telegramAuthor,
      chatLabel,
      chatId: params.message.chat.id,
      threadId: params.threadId,
      messageId: params.message.message_id,
      sourceUrl: params.routingOverride?.sourceUrl,
      rawText: params.rawText,
    });

    const issueResponse = await params.context.octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
    });
    const issueNumber = issueResponse.data.number ?? 0;
    if (!issueNumber) {
      return { ok: false, error: "Failed to create a Telegram session issue." };
    }

    const commentBody = params.rawText.trim() || "(empty)";
    const commentResponse = await params.context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: commentBody,
    });
    const commentId = commentResponse.data.id ?? 0;
    if (!commentId) {
      return {
        ok: false,
        error: "Failed to create a Telegram session comment.",
      };
    }

    const issuePayload: Record<string, unknown> = {
      number: issueNumber,
      title: issueResponse.data.title ?? title,
      body: typeof issueResponse.data.body === "string" ? issueResponse.data.body : "",
      labels: Array.isArray(issueResponse.data.labels) ? issueResponse.data.labels : [],
      user: { login: issueResponse.data.user?.login ?? owner },
      node_id: issueResponse.data.node_id,
      html_url: issueResponse.data.html_url,
      url: issueResponse.data.url,
      created_at: issueResponse.data.created_at,
    };
    if (issueResponse.data.pull_request) {
      issuePayload.pull_request = issueResponse.data.pull_request;
    }

    const payload = {
      action: "created",
      installation: { id: installationId },
      repository: {
        owner: { login: owner },
        name: repo,
        full_name: `${owner}/${repo}`,
      },
      issue: issuePayload,
      comment: {
        id: commentId,
        body: commentBody,
        user: { login: payloadAuthor, type: "User" },
        author_association: payloadAssociation,
      },
      sender: { login: payloadAuthor, type: "User" },
    };
    const event = {
      id: `telegram-${params.updateId}-${commentId}`,
      name: "issue_comment",
      payload,
    } as unknown as EmitterWebhookEvent;
    const context = new GitHubContext(params.context.eventHandler, event, params.context.octokit, params.logger);

    const issueUrl = issueResponse.data.html_url ?? buildIssueUrl({ owner, repo, issueNumber });
    params.logger.info({ event: "telegram-session", owner, repo, issueNumber }, "Created Telegram session issue");
    const override: TelegramRoutingOverride = {
      kind: "issue",
      owner,
      repo,
      issueNumber,
      installationId,
      sourceUrl: issueUrl,
    };
    let didPersist = false;
    const kv = await getTelegramKv(params.logger);
    if (kv) {
      didPersist = await saveTelegramRoutingOverride({
        botToken: params.botToken,
        chatId: params.chatId,
        threadId: params.threadId,
        override,
        logger: params.logger,
        kv,
      });
    }

    return {
      ok: true,
      context,
      hasIssueContext: true,
      createdIssue: {
        owner,
        repo,
        number: issueNumber,
        url: issueUrl,
        persisted: didPersist,
      },
      routingOverride: override,
    };
  } catch (error) {
    params.logger.warn({ err: error, owner, repo }, "Failed to create Telegram session issue");
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message ? `Failed to create a Telegram session issue: ${message}` : "Failed to create a Telegram session issue.",
    };
  }
}

export function buildTelegramIssueLink(issue: TelegramIssueCreation) {
  const label = `${issue.owner}/${issue.repo}#${issue.number}`;
  const link = `<a href="${escapeTelegramHtmlAttribute(issue.url)}">${escapeTelegramHtml(label)}</a>`;
  const suffix = issue.persisted ? "" : " Context wasn't saved; use /topic to pin it.";
  return { message: `Opened issue ${link} for this session.${suffix}` };
}

export async function hydrateTelegramIssuePayload(params: {
  octokit: GitHubContext["octokit"];
  owner: string;
  repo: string;
  issueNumber: number;
  fallbackTitle: string;
  logger: Logger;
}): Promise<{ issue: Record<string, unknown>; title: string } | null> {
  try {
    const { data } = await params.octokit.rest.issues.get({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
    });
    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : params.fallbackTitle;
    const issue: Record<string, unknown> = {
      number: data.number ?? params.issueNumber,
      title,
      body: typeof data.body === "string" ? data.body : "",
      labels: Array.isArray(data.labels) ? data.labels : [],
      user: { login: data.user?.login ?? params.owner },
      node_id: data.node_id,
      html_url: data.html_url,
      url: data.url,
      created_at: data.created_at,
    };
    if (data.pull_request) {
      issue.pull_request = data.pull_request;
    }
    return { issue, title };
  } catch (error) {
    params.logger.debug(
      {
        err: error,
        owner: params.owner,
        repo: params.repo,
        issueNumber: params.issueNumber,
      },
      "Failed to hydrate Telegram issue payload"
    );
    return null;
  }
}

export async function handleTelegramShimSlash(params: {
  botToken: string;
  chatId: number;
  replyToMessageId: number;
  command: string;
  logger: Logger;
}): Promise<boolean> {
  const command = normalizeTelegramUserCommandName(params.command);
  if (command === "_ping") {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      text: "pong",
      logger: params.logger,
    });
    return true;
  }
  return false;
}

function formatTelegramStatusTimestamp(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : String(value);
  }
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

export async function handleTelegramStatusCommand(params: {
  botToken: string;
  chatId: number;
  replyToMessageId: number;
  userId: number;
  identity: TelegramLinkedIdentity | null;
  isPrivate: boolean;
  logger: Logger;
}): Promise<boolean> {
  const lines: string[] = [];
  let replyMarkup: TelegramReplyMarkup | undefined;

  if (params.identity) {
    lines.push("Status: linked");
    lines.push(`GitHub owner: ${params.identity.owner}`);
    const githubLogin = normalizeLogin(params.identity.githubLogin ?? "");
    if (githubLogin) {
      lines.push(`GitHub login: ${githubLogin}`);
    } else {
      lines.push("GitHub login: missing (re-link required for agent approvals)");
      if (params.isPrivate) {
        lines.push(`Tap ${TELEGRAM_START_LINKING_LABEL} to re-link.`);
        replyMarkup = buildTelegramLinkingKeyboard();
      } else {
        lines.push("Re-link in direct message with /_status.");
      }
    }
    // No timestamp or config path in status per UX guidance.
  } else {
    const pendingResult = await getTelegramLinkPending({
      userId: params.userId,
      logger: params.logger,
    });
    if (!pendingResult.ok) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chatId,
        replyToMessageId: params.replyToMessageId,
        text: pendingResult.error,
        logger: params.logger,
      });
      return true;
    }

    let pending = pendingResult.pending;
    if (pending && pending.expiresAtMs <= Date.now()) {
      await clearTelegramLinkPending({
        userId: params.userId,
        logger: params.logger,
      });
      pending = null;
    }

    if (pending) {
      lines.push("Status: linking");
      if (pending.owner) {
        lines.push(`Owner: ${pending.owner}`);
      }
      if (pending.step === "awaiting_owner") {
        lines.push("Step: waiting for GitHub owner");
        lines.push("Send the GitHub owner (username or org) to continue.");
      } else {
        lines.push("Step: waiting for link issue close");
        const issueResult = await getTelegramLinkIssue({
          code: pending.code,
          logger: params.logger,
        });
        if (issueResult.ok && issueResult.issue?.issueUrl) {
          lines.push(`Issue: ${issueResult.issue.issueUrl}`);
          replyMarkup = buildTelegramIssueKeyboard(issueResult.issue.issueUrl);
        }
        lines.push("Close the issue to approve linking.");
      }
      lines.push(`Expires: ${formatTelegramStatusTimestamp(pending.expiresAtMs)}`);
    } else {
      lines.push("Status: not linked");
      if (!params.isPrivate) {
        lines.push("Linking is only available in a direct message.");
      } else {
        lines.push(`Tap ${TELEGRAM_START_LINKING_LABEL} to begin.`);
        replyMarkup = buildTelegramLinkingKeyboard();
      }
    }
  }

  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
    text: lines.join("\n"),
    ...(replyMarkup ? { replyMarkup } : {}),
    logger: params.logger,
  });
  return true;
}
