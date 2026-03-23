import { getErrorReply, getStatusPhrase } from "../src/github/utils/router-error-messages.ts";

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";

Deno.test("router error messages: builds an authentic reply with predictable components", () => {
  const randomStub = stub(Math, "random", () => 0);
  try {
    const reply = getErrorReply(500, "memory buffer full", "authentic");
    assertStringIncludes(reply, "Router logic stalled: server error. Graph state preserved; try /help.");
    assertStringIncludes(reply, "<!-- Upstream LLM 500: memory buffer full");
  } finally {
    randomStub.restore();
  }
});

Deno.test("router error messages: supports the relatable personality", () => {
  const randomStub = stub(Math, "random", () => 0);
  try {
    const reply = getErrorReply(503, "module timeout", "relatable");
    assertStringIncludes(reply, "My thinking stalled: service unavailable. Chat history safe; try /help for tools.");
    assertStringIncludes(reply, "<!-- Upstream LLM 503: module timeout");
  } finally {
    randomStub.restore();
  }
});

Deno.test("router error messages: picks a status phrase using bucket", () => {
  const randomStub = stub(Math, "random", () => 0.5);
  try {
    assertEquals(getStatusPhrase(401), "credentials stale");
  } finally {
    randomStub.restore();
  }
});
