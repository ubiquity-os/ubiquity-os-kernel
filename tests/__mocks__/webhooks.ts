/* eslint-disable @typescript-eslint/naming-convention */

export class WebhooksMocked {
  constructor(_: unknown) {}
  verifyAndReceive(_: unknown) {
    console.log("verifyAndReceive");
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
