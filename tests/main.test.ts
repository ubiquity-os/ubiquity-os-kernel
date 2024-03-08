/* eslint-disable @typescript-eslint/naming-convention */

// @ts-expect-error package name is correct, TypeScript doesn't recognize it
import { afterAll, afterEach, beforeAll, describe, expect, it, jest, mock, spyOn } from "bun:test";
mock.module("@octokit/webhooks", () => ({
  Webhooks: WebhooksMocked,
}));

class WebhooksMocked {
  constructor(_: unknown) {}
  verifyAndReceive(_: unknown) {
    return Promise.resolve();
  }
  onAny(_: unknown) {}
  on(_: unknown) {}
  onError(_: unknown) {}
  removeListener(_: unknown, __: unknown) {}
  sign(_: unknown) {}
  verify(_: unknown, __: unknown) {}
  receive(_: unknown) {}
}

import { config } from "dotenv";
import worker from "../src/worker";
import { server } from "./__mocks__/node";

config({ path: ".dev.vars" });

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("Worker tests", () => {
  it("Should fail on missing env variables", async () => {
    const req = new Request("http://localhost:8080");
    const consoleSpy = spyOn(console, "error").mockImplementation(() => jest.fn());
    const res = await worker.fetch(req, {
      WEBHOOK_SECRET: "",
      APP_ID: "",
      PRIVATE_KEY: "",
      PLUGIN_CHAIN_STATE: {} as KVNamespace,
    });
    expect(res.status).toEqual(500);
    consoleSpy.mockReset();
  });

  it("Should start a worker", async () => {
    const req = new Request("http://localhost:8080", {
      headers: {
        "x-github-event": "issues.opened",
        "x-github-delivery": "1",
        "x-hub-signature-256": "123456",
      },
    });
    const res = await worker.fetch(req, {
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
      APP_ID: process.env.APP_ID,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
      PLUGIN_CHAIN_STATE: {} as KVNamespace,
    });
    expect(res.status).toEqual(200);
  });
});
