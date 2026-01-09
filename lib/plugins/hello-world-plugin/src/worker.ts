import { createPlugin } from "@ubiquity-os/plugin-sdk";
import type { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { LOG_LEVEL } from "@ubiquity-os/ubiquity-os-logger";
import type { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import type { ExecutionContext } from "hono";
import manifest from "../manifest.json";
import { runPlugin } from "./index";
import { Command } from "./index";
import { Env, PluginSettings, SupportedEvents } from "./index";

function resolveLogLevel(value?: string): LogLevel {
  const normalized = (value ?? "").toLowerCase();
  return (Object.values(LOG_LEVEL) as LogLevel[]).includes(normalized as LogLevel) ? (normalized as LogLevel) : LOG_LEVEL.INFO;
}

export default {
  async fetch(request: Request, environment: Env, executionCtx?: ExecutionContext) {
    const plugin = createPlugin<PluginSettings, Env, Command, SupportedEvents>(
      (context) => {
        return runPlugin(context);
      },
      manifest as Manifest,
      {
        postCommentOnError: true,
        logLevel: resolveLogLevel(environment.LOG_LEVEL),
        kernelPublicKey: environment.KERNEL_PUBLIC_KEY,
        bypassSignatureVerification: environment.NODE_ENV === "local",
      }
    );

    return plugin.fetch(request, environment, executionCtx);
  },
};
