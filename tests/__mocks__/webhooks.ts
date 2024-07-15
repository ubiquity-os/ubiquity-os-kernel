/* eslint-disable @typescript-eslint/naming-convention */
import { jest } from "@jest/globals";

class WebhooksMocked {
  constructor(_: unknown) {}
  verifyAndReceive(_: unknown) {}
  onAny(_: unknown) {}
  on(_: unknown) {}
  onError(_: unknown) {}
  removeListener(_: unknown, __: unknown) {}
  sign(_: unknown) {}
  verify(_: unknown, __: unknown) {}
  receive(_: unknown) {}
}

void jest.mock("@octokit/webhooks", () => {
  const originalModule = jest.requireActual("@octokit/webhooks");
  return {
    __esModule: true,
    ...(originalModule as object),
    Webhooks: WebhooksMocked,
  };
});
