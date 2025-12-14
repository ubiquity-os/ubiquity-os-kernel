import { createPlugin } from "@ubiquity-os/plugin-sdk";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { LOG_LEVEL, LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import { ExecutionContext } from "hono";
import manifest from "../manifest.json";
import { runPlugin } from "./index";
import { Command } from "./index";
import { Env, PluginSettings, SupportedEvents } from "./index";

export default {
  async fetch(request: Request, environment: Env, executionCtx?: ExecutionContext) {
    const plugin = createPlugin<PluginSettings, Env, Command, SupportedEvents>(
      (context) => {
        return runPlugin(context);
      },
      manifest as Manifest,
      {
        postCommentOnError: true,
        logLevel: (environment.LOG_LEVEL as LogLevel) || LOG_LEVEL.INFO,
        kernelPublicKey: environment.KERNEL_PUBLIC_KEY,
        bypassSignatureVerification: process.env.NODE_ENV === "local",
      }
    );

    return plugin.fetch(request, environment, executionCtx);
  },
};
