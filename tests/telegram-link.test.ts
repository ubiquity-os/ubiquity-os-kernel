import { describe, expect, it } from "@jest/globals";
import { parseTelegramLinkCommentUrl } from "../src/telegram/link.ts";

describe("telegram link comment url parser", () => {
  it("parses issue comment anchors", () => {
    const parsed = parseTelegramLinkCommentUrl("https://github.com/acme/.ubiquity-os/issues/1#issuecomment-12345");
    expect(parsed).toEqual({ owner: "acme", repo: ".ubiquity-os", commentId: 12345 });
  });

  it("parses comments path", () => {
    const parsed = parseTelegramLinkCommentUrl("https://github.com/acme/.ubiquity-os/issues/comments/98765");
    expect(parsed).toEqual({ owner: "acme", repo: ".ubiquity-os", commentId: 98765 });
  });

  it("rejects non-github urls", () => {
    const parsed = parseTelegramLinkCommentUrl("https://example.com/acme/.ubiquity-os/issues/1#issuecomment-1");
    expect(parsed).toBeNull();
  });
});
