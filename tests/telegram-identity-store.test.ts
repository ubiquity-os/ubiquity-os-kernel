import { assert, assertEquals } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";

import {
  consumeTelegramLinkCode,
  deleteTelegramLinkIssue,
  getOrCreateTelegramLinkCode,
  getTelegramLinkedIdentity,
  getTelegramLinkIssue,
  peekTelegramLinkCode,
  saveTelegramLinkedIdentity,
  saveTelegramLinkIssue,
} from "../src/telegram/identity-store.ts";

type KvEntry = { key: unknown[]; value: unknown };

function keyStartsWith(key: unknown[], prefix: unknown[]): boolean {
  return prefix.length <= key.length && prefix.every((value, index) => key[index] === value);
}

function compareKvKey(left: unknown[], right: unknown[]): number {
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const leftValue = String(left[i]);
    const rightValue = String(right[i]);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

class InMemoryKv {
  private _entries: KvEntry[] = [];

  async get(key: unknown[]) {
    const found = this._entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key));
    return { value: found?.value ?? null };
  }

  async set(key: unknown[], value: unknown) {
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    this._entries.push({ key: [...key], value });
    return null;
  }

  async delete(key: unknown[]) {
    this._entries = this._entries.filter((entry) => JSON.stringify(entry.key) !== JSON.stringify(key));
    return null;
  }

  list(selector: { prefix: unknown[] }, options: { limit?: number; cursor?: string } = {}) {
    const sorted = this._entries.filter((entry) => keyStartsWith(entry.key, selector.prefix)).sort((a, b) => compareKvKey(a.key, b.key));
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(0, options.limit) : sorted.length;
    let startIndex = 0;
    if (options.cursor?.startsWith("idx:")) {
      const parsed = Number.parseInt(options.cursor.slice(4), 10);
      startIndex = Number.isFinite(parsed) ? parsed : 0;
    }
    const page = sorted.slice(startIndex, startIndex + limit);
    const iterator = {
      cursor: startIndex < sorted.length ? `idx:${startIndex}` : "",
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < page.length; i += 1) {
          const entry = page[i];
          const nextIndex = startIndex + i + 1;
          iterator.cursor = nextIndex < sorted.length ? `idx:${nextIndex}` : "";
          yield { key: entry.key, value: entry.value };
        }
      },
    };
    return iterator;
  }
}

const logger = { warn: () => {} };

Deno.test("telegram identity store: creates and consumes link codes", async () => {
  const kvStore = new InMemoryKv();
  const openKvStub = stub(Deno as unknown as { openKv?: () => Promise<unknown> }, "openKv", async () => kvStore);
  try {
    const result = await getOrCreateTelegramLinkCode({
      userId: 123,
      logger,
      now: () => 1_700_000_000_000,
    });
    assert(result.ok);
    if (!result.ok) return;

    const peeked = await peekTelegramLinkCode({ code: result.code, logger });
    assert(peeked.ok);
    if (peeked.ok) {
      assertEquals(peeked.userId, 123);
    }

    const consumed = await consumeTelegramLinkCode({
      code: result.code,
      logger,
    });
    assert(consumed.ok);
    if (consumed.ok) {
      assertEquals(consumed.userId, 123);
    }

    const second = await consumeTelegramLinkCode({ code: result.code, logger });
    assertEquals(second.ok, false);
  } finally {
    openKvStub.restore();
  }
});

Deno.test("telegram identity store: stores and deletes link issue records", async () => {
  const kvStore = new InMemoryKv();
  const openKvStub = stub(Deno as unknown as { openKv?: () => Promise<unknown> }, "openKv", async () => kvStore);
  try {
    const save = await saveTelegramLinkIssue({
      code: "CODE123",
      issue: {
        owner: "acme",
        repo: ".ubiquity-os",
        issueNumber: 12,
        issueUrl: "https://github.com/acme/.ubiquity-os/issues/12",
        createdAtMs: 1,
      },
      expiresAtMs: Date.now() + 60_000,
      logger,
    });
    assert(save.ok);

    const loaded = await getTelegramLinkIssue({ code: "CODE123", logger });
    assert(loaded.ok);
    if (loaded.ok) {
      assertEquals(loaded.issue?.issueNumber, 12);
    }

    const deleted = await deleteTelegramLinkIssue({ code: "CODE123", logger });
    assert(deleted.ok);
  } finally {
    openKvStub.restore();
  }
});

Deno.test("telegram identity store: saves and loads linked identities", async () => {
  const kvStore = new InMemoryKv();
  const openKvStub = stub(Deno as unknown as { openKv?: () => Promise<unknown> }, "openKv", async () => kvStore);
  try {
    const save = await saveTelegramLinkedIdentity({
      userId: 456,
      owner: "acme",
      ownerType: "user",
      githubLogin: "Alice-Dev",
      logger,
    });
    assert(save.ok);

    const loaded = await getTelegramLinkedIdentity({ userId: 456, logger });
    assert(loaded.ok);
    if (loaded.ok) {
      assertEquals(loaded.identity?.owner, "acme");
      assertEquals(loaded.identity?.githubLogin, "alice-dev");
    }
  } finally {
    openKvStub.restore();
  }
});

Deno.test("telegram identity store: prevents multiple telegram users for a personal owner", async () => {
  const kvStore = new InMemoryKv();
  const openKvStub = stub(Deno as unknown as { openKv?: () => Promise<unknown> }, "openKv", async () => kvStore);
  try {
    const first = await saveTelegramLinkedIdentity({
      userId: 1,
      owner: "solo-user",
      ownerType: "user",
      logger,
    });
    assert(first.ok);

    const second = await saveTelegramLinkedIdentity({
      userId: 2,
      owner: "solo-user",
      ownerType: "user",
      logger,
    });
    assertEquals(second.ok, false);
  } finally {
    openKvStub.restore();
  }
});

Deno.test("telegram identity store: allows multiple telegram users for an org owner", async () => {
  const kvStore = new InMemoryKv();
  const openKvStub = stub(Deno as unknown as { openKv?: () => Promise<unknown> }, "openKv", async () => kvStore);
  try {
    const first = await saveTelegramLinkedIdentity({
      userId: 10,
      owner: "acme-org",
      ownerType: "org",
      logger,
    });
    assert(first.ok);

    const second = await saveTelegramLinkedIdentity({
      userId: 11,
      owner: "acme-org",
      ownerType: "org",
      logger,
    });
    assert(second.ok);
  } finally {
    openKvStub.restore();
  }
});
