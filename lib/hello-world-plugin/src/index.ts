import { Context, callLlm } from "@ubiquity-os/plugin-sdk";
import type { ChatCompletion } from "openai/resources/chat/completions";

export type PluginSettings = Record<string, never>;
export type Env = Record<string, never>;
export interface Command {
  name: "hello" | "llm-hello";
  parameters: Record<string, never>;
}
export type SupportedEvents = "issue_comment.created";

export async function runPlugin(context: Context<PluginSettings, Env, Command, SupportedEvents>) {
  const { logger, command } = context;

  if (command?.name === "hello") {
    logger.info("Hello command received!");

    // For now, just log that we received the command
    // In a real plugin, this would post a comment back to GitHub
    console.log("Hello from the hello-world-plugin!");

    return {
      success: true,
      message: "Hello command executed successfully!",
    };
  }

  if (command?.name === "llm-hello") {
    logger.info("LLM Hello command received!");

    try {
      const result = await callLlm(
        {
          messages: [{ role: "user", content: "Generate a friendly greeting message for a user." }],
          model: "gpt-5.2-chat-latest",
        },
        context
      );

      const greeting = (result as ChatCompletion).choices[0].message.content;
      console.log("AI-generated greeting:", greeting);

      return {
        success: true,
        message: `AI says: ${greeting}`,
      };
    } catch (error) {
      logger.error("LLM call failed:", error);
      return {
        success: false,
        message: "Failed to generate greeting from AI.",
      };
    }
  }

  logger.warn(`Unsupported command: ${command?.name}`);
  return {
    success: false,
    message: `Unsupported command: ${command?.name}`,
  };
}
