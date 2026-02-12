import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubContext } from "../github/github-context.ts";
import { dispatchInternalAgent } from "../github/handlers/internal-agent.ts";
import { buildConversationContext } from "../github/utils/conversation-context.ts";
import { resolveConversationKeyForContext } from "../github/utils/conversation-graph.ts";
import { callUbqAiRouter } from "../github/utils/ai-router.ts";
import { getErrorReply } from "../github/utils/router-error-messages.ts";
import {
  buildTelegramAgentPlanningKey,
  buildTelegramAgentPlanningPrompt,
  deleteTelegramAgentPlanningSession,
  loadTelegramAgentPlanningSession,
  saveTelegramAgentPlanningSession,
  type TelegramAgentPlanningDraft,
  type TelegramAgentPlanningSession,
  tryParseTelegramAgentPlanningOutput,
} from "./agent-planning.ts";
import { safeSendTelegramMessage } from "./api-client.ts";
import { buildTelegramAgentPlanningKeyboard } from "./handler-callback.ts";
import { type TelegramAgentPlanningKeyword } from "./handler-plugin-router.ts";
import { getTelegramBotId, getTelegramKv } from "./handler-routing.ts";
import {
  type Logger,
  TELEGRAM_AGENT_PLANNING_MAX_ANSWERS,
  TELEGRAM_AGENT_PLANNING_TTL_MS,
  TELEGRAM_AGENT_TASK_MAX_CHARS,
  TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS,
  type TelegramChat,
  type TelegramMessage,
} from "./handler-shared.ts";
import { type TelegramLinkedIdentity } from "./identity-store.ts";
import { getOrBuildTelegramRepoNotes } from "./repo-notes.ts";
import { describeTelegramContextLabel, formatRoutingLabel, type TelegramRoutingConfig, type TelegramRoutingOverride } from "./routing-context.ts";
import { ensureTelegramActorWriteAccess } from "./write-access.ts";
import type { KvLike } from "../github/utils/kv-client.ts";
import { buildTelegramIssueLink, ensureTelegramIssueContext } from "./handler-issue-context.ts";

export function parseTelegramAgentPlanningKeyword(rawText: string): TelegramAgentPlanningKeyword | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const withoutMention = trimmed.replace(/^@ubiquityos\b\s*/i, "");
  const normalized = withoutMention.toLowerCase();

  if (normalized === "approve" || normalized === "/approve") {
    return "approve";
  }

  if (normalized === "finalize" || normalized === "/finalize") {
    return "finalize";
  }

  if (normalized === "cancel" || normalized === "/cancel" || normalized === "abort" || normalized === "/abort") {
    return "cancel";
  }
  return null;
}

function clampAgentTask(value: string, maxChars = TELEGRAM_AGENT_TASK_MAX_CHARS): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildTelegramAgentRunRequestCommentBody(params: {
  session: TelegramAgentPlanningSession;
  draft: TelegramAgentPlanningDraft;
  targetLabel: string | null;
}): string {
  const lines: string[] = [];
  lines.push("Telegram agent run request (approved).");
  if (params.targetLabel) lines.push(`Target: ${params.targetLabel}`);
  if (params.draft.title.trim()) {
    lines.push(`Title: ${params.draft.title.trim()}`);
  }
  lines.push("");
  if (params.session.answers.length) {
    lines.push("User answers:");
    for (const answer of params.session.answers) {
      const trimmed = answer.trim();
      if (!trimmed) continue;
      lines.push(`- ${trimmed}`);
    }
    lines.push("");
  }
  lines.push("Agent task:");
  lines.push(params.draft.agentTask.trim());
  return lines.join("\n").trim();
}

async function tryCreateTelegramAgentRunRequestCommentContext(params: {
  context: GitHubContext<"issue_comment.created">;
  updateId: number;
  body: string;
  logger: Logger;
}): Promise<GitHubContext<"issue_comment.created"> | null> {
  const owner = params.context.payload.repository?.owner?.login ?? "";
  const repo = params.context.payload.repository?.name ?? "";
  const issueNumber = params.context.payload.issue?.number ?? 0;
  const body = params.body.trim();

  if (!owner || !repo || !issueNumber || !body) return null;

  let commentId = 0;
  try {
    const response = await params.context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    commentId = response.data.id ?? 0;
  } catch (error) {
    params.logger.warn({ err: error, owner, repo, issueNumber }, "Failed to create Telegram agent request comment (non-fatal)");
    return null;
  }

  if (!commentId) return null;

  const existingUser =
    typeof params.context.payload.comment?.user?.login === "string" && params.context.payload.comment.user.login.trim()
      ? params.context.payload.comment.user.login.trim()
      : owner;
  const existingAssociation =
    typeof params.context.payload.comment?.author_association === "string" && params.context.payload.comment.author_association.trim()
      ? params.context.payload.comment.author_association.trim()
      : "NONE";

  const payload = {
    ...(params.context.payload as unknown as Record<string, unknown>),
    comment: {
      id: commentId,
      body,
      user: { login: existingUser, type: "User" },
      author_association: existingAssociation,
    },
    sender: { login: existingUser, type: "User" },
  };

  const event = {
    id: `telegram-${params.updateId}-${commentId}`,
    name: "issue_comment",
    payload,
  } as unknown as EmitterWebhookEvent;

  return new GitHubContext(params.context.eventHandler, event, params.context.octokit, params.logger);
}

function formatTelegramAgentPlanningMessage(params: {
  status: TelegramAgentPlanningSession["status"];
  title: string;
  questions: string[];
  plan: string[];
  targetLabel: string | null;
  ttlMs: number;
}): string {
  const ttlMinutes = Math.max(1, Math.round(params.ttlMs / 60_000));
  const header = params.status === "awaiting_approval" ? "Plan ready." : "Planning mode.";
  const lines: string[] = [header];
  if (params.targetLabel) {
    lines.push(`Target: ${params.targetLabel}`);
  }
  if (params.title.trim()) {
    lines.push(`Title: ${params.title.trim()}`);
  }

  if (params.questions.length) {
    lines.push("");
    lines.push("Questions:");
    for (let i = 0; i < params.questions.length; i += 1) {
      lines.push(`${i + 1}) ${params.questions[i]}`);
    }
  }

  if (params.plan.length) {
    lines.push("");
    lines.push(params.status === "awaiting_approval" ? "Plan:" : "Draft plan:");
    for (let i = 0; i < params.plan.length; i += 1) {
      lines.push(`${i + 1}) ${params.plan[i]}`);
    }
  }

  lines.push("");
  if (params.status === "awaiting_approval") {
    lines.push("Tap Approve to start the agent run, or Cancel to abort.");
    lines.push("(You can also type APPROVE/CANCEL.)");
  } else {
    lines.push("Reply with your answers (one message is fine). Tap Finalize plan to stop Q&A, or Cancel to abort.");
    lines.push("(You can also type FINALIZE/CANCEL.)");
  }
  lines.push(`(Expires in ~${ttlMinutes} min.)`);

  return lines.join("\n").trim();
}

async function getTelegramAgentPlanningDraft(params: {
  context: GitHubContext<"issue_comment.created">;
  kv: KvLike;
  request: string;
  answers: string[];
  previousDraft: TelegramAgentPlanningDraft | null;
  conversationContext: string;
  agentMemory: string;
  hasIssueContext: boolean;
  targetLabel: string | null;
  routingOverride: TelegramRoutingOverride | null;
  forceReady?: boolean;
  logger: Logger;
  onError: (message: string) => Promise<void>;
}): Promise<TelegramAgentPlanningDraft | null> {
  const prompt = buildTelegramAgentPlanningPrompt();
  const repoOwner = params.routingOverride?.owner?.trim() || params.context.payload.repository?.owner?.login || "";
  const repoName = params.routingOverride?.repo?.trim() || params.context.payload.repository?.name || "";
  const repoNotes =
    typeof repoOwner === "string" && typeof repoName === "string" && repoOwner.trim() && repoName.trim()
      ? await getOrBuildTelegramRepoNotes({
          kv: params.kv,
          octokit: params.context.octokit,
          owner: repoOwner,
          repo: repoName,
          logger: params.logger,
        })
      : null;
  const routerInput = {
    platform: "telegram",
    target: params.targetLabel ?? "",
    repositoryOwner: params.context.payload.repository.owner.login,
    repositoryName: params.context.payload.repository.name,
    issueNumber: params.context.payload.issue.number,
    issueTitle: params.context.payload.issue.title,
    issueBody: params.context.payload.issue.body,
    hasIssueContext: params.hasIssueContext,
    request: params.request,
    answers: params.answers,
    ...(params.forceReady ? { forceReady: true } : {}),
    previousDraft: params.previousDraft
      ? {
          title: params.previousDraft.title,
          questions: params.previousDraft.questions,
          plan: params.previousDraft.plan,
        }
      : null,
    repoNotes: repoNotes
      ? {
          summary: repoNotes.summary,
          inferred: repoNotes.inferred,
          languages: Object.keys(repoNotes.languages ?? {}),
        }
      : null,
    agentMemory: params.agentMemory,
    conversationContext: params.conversationContext,
  };

  try {
    const raw = await callUbqAiRouter(params.context, prompt, routerInput, {
      timeoutMs: 25_000,
    });
    const parsed = tryParseTelegramAgentPlanningOutput(raw);
    if (!parsed) {
      await params.onError("I couldn't generate a plan. Please try again.");
      return null;
    }

    const forceReady = params.forceReady === true;
    let questions: string[] = [];
    if (!forceReady && parsed.status === "need_info") {
      questions = parsed.questions;
    }
    const plan = parsed.plan ?? [];

    let agentTask = parsed.status === "ready" && parsed.agentTask ? clampAgentTask(parsed.agentTask) : "";

    if (forceReady && !agentTask) {
      const answerLines = params.answers.map((answer) => `- ${answer}`).join("\n");
      const planLines = plan.map((item) => `- ${item}`).join("\n");
      const sections: string[] = [];
      if (params.targetLabel) sections.push(`Target: ${params.targetLabel}`);
      sections.push(`Goal: ${params.request.trim()}`);
      if (answerLines) sections.push(`User-provided details:\n${answerLines}`);
      if (planLines) sections.push(`Proposed plan:\n${planLines}`);
      sections.push("Proceed with best-effort assumptions (do not ask more questions before starting).");
      sections.push("If assumptions are required, state them clearly in the final output/comment.");
      agentTask = clampAgentTask(sections.join("\n\n"));
    }

    return {
      title: parsed.title ?? "",
      questions,
      plan,
      agentTask,
    };
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 0;
    const detail = error instanceof Error ? error.message : String(error);
    const message = getErrorReply(status, detail, "relatable");
    await params.onError(message);
    return null;
  }
}

export async function startTelegramAgentPlanningSession(params: {
  context: GitHubContext<"issue_comment.created">;
  botToken: string;
  chat: TelegramChat;
  threadId: number | null;
  userId: number;
  replyToMessageId: number;
  request: string;
  conversationContext: string;
  agentMemory: string;
  hasIssueContext: boolean;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  logger: Logger;
}): Promise<void> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "KV is unavailable, so planning mode is disabled right now.",
      logger: params.logger,
    });
    return;
  }

  const request = params.request.trim();
  if (!request) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Tell me what you want to build, and I will propose a plan.",
      logger: params.logger,
    });
    return;
  }

  const botId = getTelegramBotId(params.botToken);
  const key = buildTelegramAgentPlanningKey({
    botId,
    chatId: params.chat.id,
    threadId: params.threadId,
    userId: params.userId,
  });
  const nowMs = Date.now();
  const session: TelegramAgentPlanningSession = {
    version: 1,
    id: crypto.randomUUID(),
    status: "collecting",
    request,
    answers: [],
    draft: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + TELEGRAM_AGENT_PLANNING_TTL_MS,
  };

  const targetLabel = params.routingOverride ? describeTelegramContextLabel(params.routingOverride) : formatRoutingLabel(params.routing);

  const draft = await getTelegramAgentPlanningDraft({
    context: params.context,
    kv,
    request: session.request,
    answers: session.answers,
    previousDraft: null,
    conversationContext: params.conversationContext,
    agentMemory: params.agentMemory,
    hasIssueContext: params.hasIssueContext,
    targetLabel,
    routingOverride: params.routingOverride,
    logger: params.logger,
    onError: async (message) => {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: message,
        logger: params.logger,
      });
    },
  });
  if (!draft) {
    return;
  }

  const isReady = draft.questions.length === 0 && Boolean(draft.agentTask);
  const nextSession: TelegramAgentPlanningSession = {
    ...session,
    status: isReady ? "awaiting_approval" : "collecting",
    draft,
    updatedAtMs: Date.now(),
  };

  const didSaveSession = await saveTelegramAgentPlanningSession({
    kv,
    key,
    session: nextSession,
    logger: params.logger,
  });
  if (!didSaveSession) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't save this plan. Please try again.",
      logger: params.logger,
    });
    return;
  }

  const message = formatTelegramAgentPlanningMessage({
    status: nextSession.status,
    title: draft.title,
    questions: draft.questions,
    plan: draft.plan,
    targetLabel,
    ttlMs: TELEGRAM_AGENT_PLANNING_TTL_MS,
  });
  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: params.threadId ?? undefined,
    replyToMessageId: params.replyToMessageId,
    text: message,
    replyMarkup: buildTelegramAgentPlanningKeyboard({
      status: nextSession.status,
      sessionId: nextSession.id,
    }),
    logger: params.logger,
  });
}

export async function maybeHandleTelegramAgentPlanningSession(params: {
  context: GitHubContext<"issue_comment.created">;
  botToken: string;
  chat: TelegramChat;
  threadId: number | null;
  userId: number;
  replyToMessageId: number;
  rawText: string;
  conversationContext: string;
  agentMemory: string;
  routing: TelegramRoutingConfig;
  routingOverride: TelegramRoutingOverride | null;
  channelMode: "github" | "shim";
  actorIdentity: TelegramLinkedIdentity | null;
  updateId: number;
  message: TelegramMessage;
  logger: Logger;
  hasIssueContext: boolean;
  intent?: "append" | "approve" | "cancel" | "show" | "finalize";
}): Promise<boolean> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) return false;

  const botId = getTelegramBotId(params.botToken);
  const key = buildTelegramAgentPlanningKey({
    botId,
    chatId: params.chat.id,
    threadId: params.threadId,
    userId: params.userId,
  });
  const session = await loadTelegramAgentPlanningSession({
    kv,
    key,
    logger: params.logger,
  });
  if (!session) return false;

  const targetLabel = params.routingOverride ? describeTelegramContextLabel(params.routingOverride) : formatRoutingLabel(params.routing);

  const operation = params.intent ?? parseTelegramAgentPlanningKeyword(params.rawText) ?? "append";

  if (operation === "cancel") {
    await deleteTelegramAgentPlanningSession({
      kv,
      key,
      logger: params.logger,
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Cancelled.",
      logger: params.logger,
    });
    return true;
  }

  if (operation === "show") {
    const draft = session.draft;
    const message = formatTelegramAgentPlanningMessage({
      status: session.status,
      title: draft?.title ?? "",
      questions: draft?.questions ?? [],
      plan: draft?.plan ?? [],
      targetLabel,
      ttlMs: Math.max(1, session.expiresAtMs - Date.now()),
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.threadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: message,
      replyMarkup: buildTelegramAgentPlanningKeyboard({
        status: session.status,
        sessionId: session.id,
      }),
      logger: params.logger,
    });
    return true;
  }

  if (operation === "finalize") {
    const draft = await getTelegramAgentPlanningDraft({
      context: params.context,
      kv,
      request: session.request,
      answers: session.answers,
      previousDraft: session.draft,
      conversationContext: params.conversationContext,
      agentMemory: params.agentMemory,
      hasIssueContext: params.hasIssueContext,
      targetLabel,
      routingOverride: params.routingOverride,
      forceReady: true,
      logger: params.logger,
      onError: async (message) => {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: message,
          logger: params.logger,
        });
      },
    });
    if (!draft) return true;

    const nextSession: TelegramAgentPlanningSession = {
      ...session,
      status: "awaiting_approval",
      draft,
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + TELEGRAM_AGENT_PLANNING_TTL_MS,
    };
    const didSaveUpdatedSession = await saveTelegramAgentPlanningSession({
      kv,
      key,
      session: nextSession,
      logger: params.logger,
    });
    if (!didSaveUpdatedSession) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: "I couldn't save the updated plan. Please try again.",
        logger: params.logger,
      });
      return true;
    }

    const message = formatTelegramAgentPlanningMessage({
      status: nextSession.status,
      title: draft.title,
      questions: draft.questions,
      plan: draft.plan,
      targetLabel,
      ttlMs: TELEGRAM_AGENT_PLANNING_TTL_MS,
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.threadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: message,
      replyMarkup: buildTelegramAgentPlanningKeyboard({
        status: nextSession.status,
        sessionId: nextSession.id,
      }),
      logger: params.logger,
    });
    return true;
  }

  if (operation === "approve") {
    const draft = session.draft;
    if (session.status !== "awaiting_approval" || !draft?.agentTask) {
      const message = formatTelegramAgentPlanningMessage({
        status: session.status,
        title: draft?.title ?? "",
        questions: draft?.questions ?? [],
        plan: draft?.plan ?? [],
        targetLabel,
        ttlMs: Math.max(1, session.expiresAtMs - Date.now()),
      });
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        messageThreadId: params.threadId ?? undefined,
        replyToMessageId: params.replyToMessageId,
        text: message,
        replyMarkup: buildTelegramAgentPlanningKeyboard({
          status: session.status,
          sessionId: session.id,
        }),
        logger: params.logger,
      });
      return true;
    }

    const writeAccess = await ensureTelegramActorWriteAccess({
      context: params.context,
      actorIdentity: params.actorIdentity,
      logger: params.logger,
    });
    if (!writeAccess.ok) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: writeAccess.error,
        logger: params.logger,
      });
      return true;
    }

    let context = params.context;

    if (params.channelMode === "shim" && !params.hasIssueContext) {
      const ensured = await ensureTelegramIssueContext({
        context,
        routing: params.routing,
        routingOverride: params.routingOverride,
        updateId: params.updateId,
        message: params.message,
        rawText: session.request,
        botToken: params.botToken,
        chatId: params.chat.id,
        threadId: params.threadId ?? undefined,
        logger: params.logger,
      });
      if (!ensured.ok) {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: ensured.error,
          logger: params.logger,
        });
        return true;
      }
      if (ensured.createdIssue) {
        const link = buildTelegramIssueLink(ensured.createdIssue);
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: link.message,
          parseMode: "HTML",
          disablePreview: true,
          logger: params.logger,
        });
      }
      context = ensured.context;
    }

    // Ensure we have a real GitHub comment to attach agent run status updates to.
    // Telegram "shim" ingress uses synthetic comment ids (Telegram update ids), which don't exist in GitHub REST.
    // The agent workflow expects a real `comment.id` for request comment updates.
    if (params.channelMode === "shim") {
      const requestCommentBody = buildTelegramAgentRunRequestCommentBody({
        session,
        draft,
        targetLabel,
      });
      const requestContext = await tryCreateTelegramAgentRunRequestCommentContext({
        context,
        updateId: params.updateId,
        body: requestCommentBody,
        logger: params.logger,
      });
      if (requestContext) {
        context = requestContext;
      }
    }

    await deleteTelegramAgentPlanningSession({
      kv,
      key,
      logger: params.logger,
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Starting agent run.",
      logger: params.logger,
    });

    const dispatchResult = await dispatchInternalAgent(context, draft.agentTask, {
      postReply: async (body) => {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: body,
          logger: params.logger,
        });
      },
      settingsOverrides: {
        allowedAuthorAssociations: TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS,
        // Telegram requests use synthetic GitHub event payloads where
        // `author_association` may be "NONE" even when write access was verified above.
        // Grant privileged agent capabilities once GitHub write access is confirmed.
        privilegedAuthorAssociations: TELEGRAM_ALLOWED_AUTHOR_ASSOCIATIONS,
      },
    });
    if (dispatchResult?.runUrl) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: `Run logs: ${dispatchResult.runUrl}`,
        logger: params.logger,
      });
    } else if (dispatchResult?.workflowUrl) {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: `Workflow: ${dispatchResult.workflowUrl}`,
        logger: params.logger,
      });
    }
    return true;
  }

  const answer = params.rawText
    .trim()
    .replace(/^@ubiquityos\b\s*/i, "")
    .trim();
  if (!answer) {
    const draft = session.draft;
    const message = formatTelegramAgentPlanningMessage({
      status: session.status,
      title: draft?.title ?? "",
      questions: draft?.questions ?? [],
      plan: draft?.plan ?? [],
      targetLabel,
      ttlMs: Math.max(1, session.expiresAtMs - Date.now()),
    });
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      messageThreadId: params.threadId ?? undefined,
      replyToMessageId: params.replyToMessageId,
      text: message,
      replyMarkup: buildTelegramAgentPlanningKeyboard({
        status: session.status,
        sessionId: session.id,
      }),
      logger: params.logger,
    });
    return true;
  }

  const nextAnswers = [...session.answers, answer].filter(Boolean);
  const boundedAnswers = nextAnswers.slice(Math.max(0, nextAnswers.length - TELEGRAM_AGENT_PLANNING_MAX_ANSWERS));

  const draft = await getTelegramAgentPlanningDraft({
    context: params.context,
    kv,
    request: session.request,
    answers: boundedAnswers,
    previousDraft: session.draft,
    conversationContext: params.conversationContext,
    agentMemory: params.agentMemory,
    hasIssueContext: params.hasIssueContext,
    targetLabel,
    routingOverride: params.routingOverride,
    logger: params.logger,
    onError: async (message) => {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: message,
        logger: params.logger,
      });
    },
  });
  if (!draft) return true;

  const isReady = draft.questions.length === 0 && Boolean(draft.agentTask);
  const nextSession: TelegramAgentPlanningSession = {
    ...session,
    status: isReady ? "awaiting_approval" : "collecting",
    answers: boundedAnswers,
    draft,
    updatedAtMs: Date.now(),
    expiresAtMs: Date.now() + TELEGRAM_AGENT_PLANNING_TTL_MS,
  };
  const didSaveUpdatedSession = await saveTelegramAgentPlanningSession({
    kv,
    key,
    session: nextSession,
    logger: params.logger,
  });
  if (!didSaveUpdatedSession) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "I couldn't save the updated plan. Please try again.",
      logger: params.logger,
    });
    return true;
  }

  const message = formatTelegramAgentPlanningMessage({
    status: nextSession.status,
    title: draft.title,
    questions: draft.questions,
    plan: draft.plan,
    targetLabel,
    ttlMs: TELEGRAM_AGENT_PLANNING_TTL_MS,
  });
  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    messageThreadId: params.threadId ?? undefined,
    replyToMessageId: params.replyToMessageId,
    text: message,
    replyMarkup: buildTelegramAgentPlanningKeyboard({
      status: nextSession.status,
      sessionId: nextSession.id,
    }),
    logger: params.logger,
  });
  return true;
}

export async function buildTelegramConversationContext(params: {
  context: GitHubContext;
  query: string;
  logger: Logger;
  maxItems: number;
  maxChars: number;
  maxComments?: number;
  maxCommentChars?: number;
  includeComments?: boolean;
  includeSemantic?: boolean;
  useSelector: boolean;
}): Promise<string> {
  try {
    const conversation = await resolveConversationKeyForContext(params.context, params.logger);
    if (!conversation) return "";
    return await buildConversationContext({
      context: params.context,
      conversation,
      maxItems: params.maxItems,
      maxChars: params.maxChars,
      maxComments: params.maxComments,
      maxCommentChars: params.maxCommentChars,
      includeComments: params.includeComments,
      includeSemantic: params.includeSemantic,
      query: params.query,
      useSelector: params.useSelector,
    });
  } catch (error) {
    params.logger.warn({ err: error }, "Failed to build Telegram conversation context");
    return "";
  }
}
