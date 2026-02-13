import { assertEquals, assertExists } from "jsr:@std/assert";

import { decodeConfiguration } from "../src/github/utils/config.ts";
import { logger } from "../src/logger/logger.ts";

Deno.test("Plugin configuration: allows custom event names in runsOn", () => {
  const pluginKey = "ubiquity-os-marketplace/custom-ingress-plugin";
  const customEvents = ["telegram.message", "google_drive.change", "kernel.plugin_error"];

  const { config, errors } = decodeConfiguration(
    { logger } as never,
    { owner: "ubiquity-os", repo: "ubiquity-os-kernel" } as never,
    {
      plugins: {
        [pluginKey]: {
          runsOn: customEvents,
          skipBotEvents: false,
          with: {},
        },
      },
    } as never
  );

  assertEquals(errors, null);
  assertExists(config);
  assertEquals(config.plugins[pluginKey]?.runsOn, customEvents);
});
