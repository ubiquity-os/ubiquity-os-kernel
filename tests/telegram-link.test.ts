import { assertEquals } from "jsr:@std/assert";
import { parseTelegramLinkCommentUrl } from "../src/telegram/link.ts";

Deno.test("telegram link comment url parser: parses issue comment anchors", () => {
  const parsed = parseTelegramLinkCommentUrl("https://github.com/acme/.ubiquity-os/issues/1#issuecomment-12345");
  assertEquals(parsed, { owner: "acme", repo: ".ubiquity-os", commentId: 12345 });
});

Deno.test("telegram link comment url parser: parses comments path", () => {
  const parsed = parseTelegramLinkCommentUrl("https://github.com/acme/.ubiquity-os/issues/comments/98765");
  assertEquals(parsed, { owner: "acme", repo: ".ubiquity-os", commentId: 98765 });
});

Deno.test("telegram link comment url parser: rejects non-github urls", () => {
  const parsed = parseTelegramLinkCommentUrl("https://example.com/acme/.ubiquity-os/issues/1#issuecomment-1");
  assertEquals(parsed, null);
});
