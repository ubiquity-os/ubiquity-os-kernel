import { describe, expect, it, jest } from "@jest/globals";
import worker from "../src/worker";

describe("Worker tests", () => {
  it("Should start a worker", async () => {
    const req = new Request("");
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => jest.fn());
    const res = await worker.fetch(req, {
      WEBHOOK_SECRET: "",
      APP_ID: "",
      PRIVATE_KEY: "",
    });
    expect(res.status).toEqual(500);
    consoleSpy.mockReset();
  });
});
