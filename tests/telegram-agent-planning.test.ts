import { assertEquals, assert } from "jsr:@std/assert";

import {
  buildTelegramAgentPlanningKey,
  loadTelegramAgentPlanningSession,
  saveTelegramAgentPlanningSession,
  tryParseTelegramAgentPlanningOutput,
  type TelegramAgentPlanningSession,
} from "../src/telegram/agent-planning.ts";

type KvEntry = { key: unknown[]; value: unknown };

class InMemoryKv {
  private _entries: KvEntry[] = [];

  async get(key: readonly unknown[]) {
    const found = this._entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key));
    return { value: found?.value ?? null, versionstamp: null };
  }

  async set(key: readonly unknown[], value: unknown, options?: unknown) {
    void options;
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    this._entries.push({ key: [...key], value });
    return null;
  }

  async delete(key: readonly unknown[]) {
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    return null;
  }

  list(selector: { prefix: readonly unknown[] }, options: { reverse?: boolean; limit?: number; cursor?: string } = {}) {
    void selector;
    void options;
    return {
      cursor: "",
      async *[Symbol.asyncIterator]() {
        // unused
      },
    };
  }
}

Deno.test("telegram agent planning store: saves and loads session", async () => {
  const kv = new InMemoryKv();
  const key = buildTelegramAgentPlanningKey({
    botId: "123",
    chatId: 555,
    threadId: null,
    userId: 42,
  });

  const nowMs = 1_700_000_000_000;
  const session: TelegramAgentPlanningSession = {
    version: 1,
    id: "session-1",
    status: "collecting",
    request: "Add a /feature command",
    answers: [],
    draft: {
      title: "Feature request flow",
      questions: ["Which repo?"],
      plan: ["Add KV-backed planning state"],
      agentTask: "Implement planning",
    },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
  };

  const didSave = await saveTelegramAgentPlanningSession({
    kv: kv as never,
    key,
    session,
    nowMs,
  });
  assertEquals(didSave, true);

  const loaded = await loadTelegramAgentPlanningSession({
    kv: kv as never,
    key,
    nowMs,
  });
  assert(loaded);
  assertEquals(loaded.id, session.id);
  assertEquals(loaded.request, session.request);
  assertEquals(loaded.draft?.title, session.draft?.title);
});

Deno.test("telegram agent planning store: expires sessions", async () => {
  const kv = new InMemoryKv();
  const key = buildTelegramAgentPlanningKey({
    botId: "123",
    chatId: 555,
    threadId: 99,
    userId: 42,
  });

  const nowMs = 1_700_000_000_000;
  const session: TelegramAgentPlanningSession = {
    version: 1,
    id: "session-2",
    status: "awaiting_approval",
    request: "Do the thing",
    answers: ["Answer"],
    draft: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + 10,
  };

  const didSave = await saveTelegramAgentPlanningSession({
    kv: kv as never,
    key,
    session,
    nowMs,
  });
  assertEquals(didSave, true);

  const loaded = await loadTelegramAgentPlanningSession({
    kv: kv as never,
    key,
    nowMs: nowMs + 11,
  });
  assertEquals(loaded, null);
});

Deno.test("telegram agent planning parser: parses code-fenced json", () => {
  const raw = '```json\n{"status":"need_info","title":"T","questions":["Q1"],"plan":["S1"]}\n```';
  const parsed = tryParseTelegramAgentPlanningOutput(raw);
  assert(parsed);
  assertEquals(parsed.status, "need_info");
  assertEquals(parsed.questions.length, 1);
});

Deno.test("telegram agent planning parser: extracts json object from noisy output", () => {
  const raw = 'noise {"status":"ready","title":"T","questions":[],"plan":["S1"],"agentTask":"Do it"} trailing';
  const parsed = tryParseTelegramAgentPlanningOutput(raw);
  assert(parsed);
  assertEquals(parsed.status, "ready");
  assertEquals(parsed.agentTask, "Do it");
});

Deno.test("telegram agent planning parser: rejects ready without agentTask", () => {
  const raw = '{"status":"ready","title":"T","questions":[],"plan":[]}';
  const parsed = tryParseTelegramAgentPlanningOutput(raw);
  assertEquals(parsed, null);
});
