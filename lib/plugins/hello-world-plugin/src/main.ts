import { createActionsPlugin } from "@ubiquity-os/plugin-sdk";
import { LOG_LEVEL } from "@ubiquity-os/ubiquity-os-logger";
import type { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import type { Command, Env, PluginSettings, SupportedEvents } from "./index";
import { runPlugin } from "./index";

function resolveLogLevel(value?: string): LogLevel {
  const normalized = (value ?? "").toLowerCase();
  return (Object.values(LOG_LEVEL) as LogLevel[]).includes(normalized as LogLevel) ? (normalized as LogLevel) : LOG_LEVEL.INFO;
}

createActionsPlugin<PluginSettings, Env, Command, SupportedEvents>(
  (context) => {
    return runPlugin(context);
  },
  {
    postCommentOnError: true,
    logLevel: resolveLogLevel(process.env.LOG_LEVEL),
    kernelPublicKey: process.env.KERNEL_PUBLIC_KEY,
  }
).catch(console.error);
