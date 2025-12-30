import type { Context } from "@ubiquity-os/plugin-sdk";
import { callLlm, sanitizeLlmResponse } from "@ubiquity-os/plugin-sdk";
import type { ChatCompletion } from "openai/resources/chat/completions";

export type PluginSettings = Record<string, never>;
export type Env = {
  LOG_LEVEL?: string;
  KERNEL_PUBLIC_KEY?: string;
};
export type Command =
  | {
      name: "hello";
      parameters: Record<string, never>;
    }
  | {
      name: "llm";
      parameters: {
        prompt?: string;
      };
    };
export type SupportedEvents = "issue_comment.created";

export async function runPlugin(context: Context<PluginSettings, Env, Command, SupportedEvents>) {
  const { logger, command } = context;

  if (!command) {
    logger.warn("No command provided");
    return {
      success: false,
      message: "No command provided.",
    };
  }

  switch (command.name) {
    case "hello": {
      logger.info("Hello command received!");

      console.log("Hello from the hello-world-plugin!");

      return {
        success: true,
        message: "Hello command executed successfully!",
      };
    }
    case "llm": {
      const prompt = command.parameters.prompt?.trim() ?? "";
      if (!prompt) {
        return {
          success: false,
          message: "Missing prompt. Usage: `/llm <prompt>`",
        };
      }

      try {
        const result = await callLlm(
          {
            messages: [{ role: "user", content: prompt }],
          },
          context
        );

        const content = sanitizeLlmResponse((result as ChatCompletion).choices?.[0]?.message?.content ?? "");
        await context.commentHandler.postComment(context, logger.info(content || "(empty response)"), { raw: true });

        return { success: true, message: "Posted LLM response." };
      } catch (error) {
        logger.error("LLM call failed", { err: error });

        try {
          await context.commentHandler.postComment(context, logger.warn("Failed to run `/llm` right now."), { raw: true });
        } catch (commentError) {
          logger.warn("Failed to post error comment", { err: commentError });
        }

        return {
          success: false,
          message: "Failed to run /llm.",
        };
      }
    }
  }

  return {
    success: false,
    message: "Unsupported command.",
  };
}
