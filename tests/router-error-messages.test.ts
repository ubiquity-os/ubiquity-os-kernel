import { getErrorReply, getStatusPhrase } from "../src/github/utils/router-error-messages.ts";

describe("router error messages", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("builds an authentic reply with predictable components", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const reply = getErrorReply(500, "memory buffer full", "authentic");
    expect(reply).toContain("Router logic stalled: server error. Graph state preserved; try /help.");
    expect(reply).toContain("<!-- Upstream LLM 500: memory buffer full");
  });

  it("supports the relatable personality", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const reply = getErrorReply(503, "module timeout", "relatable");
    expect(reply).toContain("My thinking stalled: service unavailable. Chat history safe; try /help for tools.");
    expect(reply).toContain("<!-- Upstream LLM 503: module timeout");
  });

  it("picks a status phrase using the bucket for the provided status", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    expect(getStatusPhrase(401)).toBe("credentials stale");
  });
});
