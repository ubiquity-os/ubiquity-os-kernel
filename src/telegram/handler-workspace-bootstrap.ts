import { safeSendTelegramMessage } from "./api-client.ts";
import {
  isTelegramChatUnavailableError,
  safeCreateTelegramChatInviteLink,
  safeGetTelegramChatMemberCount,
  safeIsTelegramChatAdmin,
  safeLeaveTelegramChat,
  safePromoteTelegramChatMember,
  safeSetTelegramChatPhoto,
} from "./handler-chat-admin.ts";
import {
  deleteTelegramWorkspaceBootstrap,
  loadTelegramWorkspaceBootstrapByChat,
  loadTelegramWorkspaceBootstrapByUser,
  saveTelegramWorkspaceBootstrap,
} from "./workspace-bootstrap-store.ts";
import { claimTelegramWorkspace, loadTelegramWorkspaceByChat, loadTelegramWorkspaceByUser, unclaimTelegramWorkspace } from "./workspace-store.ts";
import { createTelegramWorkspaceForumSupergroup } from "./workspace-bootstrap.ts";
import { normalizeLogin } from "./normalization.ts";
import { clampTelegramTopicName, deleteTelegramRoutingOverridesForChat, getTelegramBotId, getTelegramKv } from "./handler-routing.ts";
import { type Logger, type TelegramChat, type TelegramChatMemberUpdated, type TelegramSecretsConfig } from "./handler-shared.ts";

export async function handleTelegramChatMemberUpdate(params: { botToken: string; update: TelegramChatMemberUpdated; logger: Logger }): Promise<void> {
  const chatId = typeof params.update.chat?.id === "number" ? params.update.chat.id : null;
  if (!chatId || !Number.isFinite(chatId)) return;

  const userId = typeof params.update.new_chat_member?.user?.id === "number" ? params.update.new_chat_member.user.id : null;
  if (!userId || !Number.isFinite(userId)) return;

  const oldStatus = params.update.old_chat_member?.status?.trim().toLowerCase() ?? "";
  const newStatus = params.update.new_chat_member?.status?.trim().toLowerCase() ?? "";

  if (newStatus === "kicked" || newStatus === "left") {
    params.logger.info(
      {
        chatId,
        userId,
        oldStatus,
        newStatus,
        event: "telegram-chat-member",
      },
      "Telegram chat member update"
    );
    await maybeHandleTelegramWorkspaceOwnerLeft({
      botToken: params.botToken,
      chatId,
      userId,
      logger: params.logger,
    });
    return;
  }

  // `chat_member` updates are the most reliable signal for join/leave events. Use them to
  // finalize DM-bootstrapped workspaces even when "join messages" are disabled in the group.
  if ((newStatus === "member" || newStatus === "administrator" || newStatus === "creator") && newStatus !== oldStatus) {
    params.logger.info(
      {
        chatId,
        userId,
        oldStatus,
        newStatus,
        event: "telegram-chat-member",
      },
      "Telegram chat member update"
    );
    await maybeFinalizeTelegramWorkspaceBootstrap({
      botToken: params.botToken,
      chatId,
      userId,
      logger: params.logger,
      source: "chat_member",
    });
  }
}

export async function maybeHandleTelegramWorkspaceOwnerLeft(params: { botToken: string; chatId: number; userId: number; logger: Logger }): Promise<void> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) return;

  const botId = getTelegramBotId(params.botToken);
  const workspace = await loadTelegramWorkspaceByChat({
    kv,
    botId,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (!workspace) return;
  if (workspace.userId !== params.userId) return;

  const unclaimed = await unclaimTelegramWorkspace({
    kv,
    botId,
    userId: params.userId,
    logger: params.logger,
  });
  if (!unclaimed.ok) {
    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        error: unclaimed.error,
      },
      "Failed to unclaim Telegram workspace after member left"
    );
    return;
  }

  const memberCount = await safeGetTelegramChatMemberCount({
    botToken: params.botToken,
    chatId: params.chatId,
    logger: params.logger,
  });
  // Terminate the workspace chat only when the bot is the sole remaining member.
  if (memberCount !== null && memberCount <= 1) {
    await safeLeaveTelegramChat({
      botToken: params.botToken,
      chatId: params.chatId,
      logger: params.logger,
    });
  }
}

export async function maybeFinalizeTelegramWorkspaceBootstrap(params: {
  botToken: string;
  chatId: number;
  userId: number;
  logger: Logger;
  source: "chat_member" | "message.new_chat_members" | "message.sender";
}): Promise<void> {
  const kv = await getTelegramKv(params.logger);
  if (!kv) return;

  const botId = getTelegramBotId(params.botToken);
  const pending = await loadTelegramWorkspaceBootstrapByChat({
    kv,
    botId,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (!pending) return;
  if (pending.userId !== params.userId) return;

  params.logger.info(
    {
      chatId: params.chatId,
      userId: params.userId,
      source: params.source,
    },
    "Workspace bootstrap: finalizing"
  );

  const claim = await claimTelegramWorkspace({
    kv,
    botId,
    userId: params.userId,
    chatId: params.chatId,
    logger: params.logger,
  });
  if (!claim.ok) {
    params.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        error: claim.error,
      },
      "Workspace bootstrap claim failed"
    );
    return;
  }

  params.logger.info(
    {
      chatId: params.chatId,
      userId: params.userId,
      changed: claim.changed,
      claimedAt: claim.record.claimedAt,
    },
    "Workspace bootstrap: claimed"
  );

  const isAdmin = await safeIsTelegramChatAdmin({
    botToken: params.botToken,
    chatId: params.chatId,
    userId: params.userId,
    logger: params.logger,
  });

  params.logger.info({ chatId: params.chatId, userId: params.userId, isAdmin }, "Workspace bootstrap: admin status");

  if (isAdmin === false) {
    const promoteResult = await safePromoteTelegramChatMember({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: params.userId,
      logger: params.logger,
    });
    if (!promoteResult.ok) {
      params.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          error: promoteResult.error,
        },
        "Workspace bootstrap promotion failed"
      );
      // Keep the pending record so the user can retry after permissions are fixed.
      return;
    }
    params.logger.info(
      {
        chatId: params.chatId,
        userId: params.userId,
        attempt: promoteResult.attempt,
      },
      "Workspace bootstrap: promoted"
    );
    const isAdminAfter = await safeIsTelegramChatAdmin({
      botToken: params.botToken,
      chatId: params.chatId,
      userId: params.userId,
      logger: params.logger,
    });
    if (isAdminAfter !== true) {
      return;
    }
  } else if (isAdmin === null) {
    // If we can't verify, keep the pending record to retry later.
    params.logger.warn({ chatId: params.chatId, userId: params.userId }, "Workspace bootstrap: couldn't verify admin status; will retry later");
    return;
  }

  await deleteTelegramWorkspaceBootstrap({
    kv,
    botId,
    userId: params.userId,
    chatId: params.chatId,
    logger: params.logger,
  });
  params.logger.info({ chatId: params.chatId, userId: params.userId }, "Workspace bootstrap: completed");
}

export async function handleTelegramWorkspaceBootstrapCommand(params: {
  botToken: string;
  chat: TelegramChat;
  userId: number;
  replyToMessageId: number;
  allowWorkspace: boolean;
  secrets: TelegramSecretsConfig;
  owner: string;
  logger: Logger;
}): Promise<boolean> {
  if (!params.allowWorkspace) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Workspace topics are only available in shim mode.",
      logger: params.logger,
    });
    return true;
  }

  if (params.chat.type !== "private") {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Run /workspace in a direct message with the bot.",
      logger: params.logger,
    });
    return true;
  }

  const apiId = params.secrets.apiId;
  const apiHash = params.secrets.apiHash?.trim() ?? "";
  const userSession = params.secrets.userSession?.trim() ?? "";
  if (!apiId || !apiHash || !userSession) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "Workspace bootstrap isn't configured. For local dev, run: deno task telegram:user:login:write",
      logger: params.logger,
    });
    return true;
  }

  const kv = await getTelegramKv(params.logger);
  if (!kv) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: "KV is unavailable, so I can't bootstrap a workspace right now.",
      logger: params.logger,
    });
    return true;
  }

  const botId = getTelegramBotId(params.botToken);
  const workspacePhotoFileId = params.secrets.workspacePhotoFileId?.trim() ?? "";
  const existingWorkspace = await loadTelegramWorkspaceByUser({
    kv,
    botId,
    userId: params.userId,
    logger: params.logger,
  });
  if (existingWorkspace) {
    const invite = await safeCreateTelegramChatInviteLink({
      botToken: params.botToken,
      chatId: existingWorkspace.chatId,
      name: "workspace access",
      logger: params.logger,
    });

    if (invite.ok) {
      let workspacePhotoWarning: string | null = null;
      if (workspacePhotoFileId) {
        const photo = await safeSetTelegramChatPhoto({
          botToken: params.botToken,
          chatId: existingWorkspace.chatId,
          photoFileId: workspacePhotoFileId,
          logger: params.logger,
        });
        if (!photo.ok) {
          params.logger.warn({ chatId: existingWorkspace.chatId, error: photo.error }, "Workspace existing-group photo refresh failed");
          workspacePhotoWarning = photo.error;
        }
      }
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: [
          "You already have a workspace group.",
          "",
          "Open/join link:",
          invite.inviteLink,
          "",
          "To create a new one, delete/leave the group and run /workspace again.",
          workspacePhotoWarning ? `Note: workspace image setup failed (${workspacePhotoWarning}).` : null,
        ].join("\n"),
        logger: params.logger,
      });
      return true;
    }

    // If the bot can't access the old chat (deleted / kicked), clear the stale mapping and proceed.
    if (isTelegramChatUnavailableError(invite.description)) {
      const pending = await loadTelegramWorkspaceBootstrapByChat({
        kv,
        botId,
        chatId: existingWorkspace.chatId,
        logger: params.logger,
      });
      if (pending) {
        await deleteTelegramWorkspaceBootstrap({
          kv,
          botId,
          userId: pending.userId,
          chatId: existingWorkspace.chatId,
          logger: params.logger,
        });
      }
      await deleteTelegramRoutingOverridesForChat({
        kv,
        botId,
        chatId: existingWorkspace.chatId,
        logger: params.logger,
      });

      const unclaimed = await unclaimTelegramWorkspace({
        kv,
        botId,
        userId: params.userId,
        logger: params.logger,
      });
      if (!unclaimed.ok) {
        await safeSendTelegramMessage({
          botToken: params.botToken,
          chatId: params.chat.id,
          replyToMessageId: params.replyToMessageId,
          text: `I couldn't clear your previous workspace mapping. Please try again.\n\n${unclaimed.error}`,
          logger: params.logger,
        });
        return true;
      }
      // fallthrough: create a new workspace
    } else {
      await safeSendTelegramMessage({
        botToken: params.botToken,
        chatId: params.chat.id,
        replyToMessageId: params.replyToMessageId,
        text: [
          "You already have a workspace group, but I couldn't create a join link for it.",
          "",
          invite.error,
          "",
          "To create a new one, delete/leave the group and run /workspace again.",
        ].join("\n"),
        logger: params.logger,
      });
      return true;
    }
  }

  const pending = await loadTelegramWorkspaceBootstrapByUser({
    kv,
    botId,
    userId: params.userId,
    logger: params.logger,
  });
  if (pending?.inviteLink) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: `You already have a pending workspace invite:\n${pending.inviteLink}`,
      logger: params.logger,
    });
    return true;
  }

  const ownerLabel = normalizeLogin(params.owner);
  const titleSuffix = ownerLabel ? ` (${ownerLabel})` : "";
  const title = clampTelegramTopicName(`UbiquityOS Workspace${titleSuffix}`);
  const about = "UbiquityOS workspace group.";

  const created = await createTelegramWorkspaceForumSupergroup({
    mtproto: { apiId, apiHash, userSession },
    botToken: params.botToken,
    title,
    about,
    logger: params.logger,
  });
  if (!created.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: created.error,
      logger: params.logger,
    });
    return true;
  }

  let workspacePhotoWarning: string | null = null;
  if (workspacePhotoFileId) {
    const photo = await safeSetTelegramChatPhoto({
      botToken: params.botToken,
      chatId: created.chatId,
      photoFileId: workspacePhotoFileId,
      logger: params.logger,
    });
    if (!photo.ok) {
      // Non-fatal: the invite link + bootstrap can proceed even if the avatar fails.
      params.logger.warn({ chatId: created.chatId, error: photo.error }, "Workspace bootstrap: failed to set workspace photo");
      workspacePhotoWarning = photo.error;
    }
  }

  const invite = await safeCreateTelegramChatInviteLink({
    botToken: params.botToken,
    chatId: created.chatId,
    name: "workspace bootstrap",
    logger: params.logger,
  });
  if (!invite.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: invite.error,
      logger: params.logger,
    });
    return true;
  }

  const saved = await saveTelegramWorkspaceBootstrap({
    kv,
    botId,
    userId: params.userId,
    chatId: created.chatId,
    inviteLink: invite.inviteLink,
    logger: params.logger,
  });
  if (!saved.ok) {
    await safeSendTelegramMessage({
      botToken: params.botToken,
      chatId: params.chat.id,
      replyToMessageId: params.replyToMessageId,
      text: saved.error,
      logger: params.logger,
    });
    return true;
  }

  params.logger.info(
    {
      chatId: created.chatId,
      userId: params.userId,
      event: "telegram-workspace-bootstrap",
      phase: "pending_saved",
    },
    "Workspace bootstrap: pending activation saved"
  );

  await safeSendTelegramMessage({
    botToken: params.botToken,
    chatId: params.chat.id,
    replyToMessageId: params.replyToMessageId,
    text: [
      `Workspace created: ${created.title}`,
      "",
      "Join link:",
      invite.inviteLink,
      "",
      "Once you join, I'll activate the workspace (and promote you to admin). If that doesn't happen, send /help in the group to retry.",
      workspacePhotoWarning ? `Note: workspace image setup failed (${workspacePhotoWarning}).` : null,
    ].join("\n"),
    logger: params.logger,
  });

  return true;
}
