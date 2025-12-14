import { Context } from "@ubiquity-os/plugin-sdk";

type PluginSettings = Record<string, never>;
type Env = Record<string, never>;
interface Command {
  name: "hello";
  parameters: Record<string, never>;
}
type SupportedEvents = "issue_comment.created";

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

  logger.warn(`Unsupported command: ${command?.name}`);
  return {
    success: false,
    message: `Unsupported command: ${command?.name}`,
  };
}
