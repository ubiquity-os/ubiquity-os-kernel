import { afterAll, afterEach, beforeAll, describe, expect, it, jest, mock, spyOn } from "bun:test";
mock.module("@octokit/webhooks", () => ({
  Webhooks: WebhooksMocked,
}));

class WebhooksMocked {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  constructor(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
  verifyAndReceive(_: unknown) {
    return Promise.resolve();
  }
  // eslint-disable-next-line @typescript-eslint/naming-convention
  onAny(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
  on(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
  onError(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
  removeListener(_: unknown, __: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
  sign(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
  verify(_: unknown, __: unknown) {}
  // eslint-disable-next-line @typescript-eslint/naming-convention
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
    });
    expect(res.status).toEqual(200);
  });
});
