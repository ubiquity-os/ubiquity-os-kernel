import { createActionsPlugin } from "@ubiquity-os/plugin-sdk";
import type { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import type { Command, Env, PluginSettings, SupportedEvents } from "./index";
import { runPlugin } from "./index";

createActionsPlugin<PluginSettings, Env, Command, SupportedEvents>(
  (context) => {
    return runPlugin(context);
  },
  {
    postCommentOnError: true,
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    kernelPublicKey: process.env.KERNEL_PUBLIC_KEY,
  }
).catch(console.error);
