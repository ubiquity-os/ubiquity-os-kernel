import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";

import { Buffer } from "node:buffer";

import type { GitHubContext } from "../src/github/github-context.ts";
import { handleTelegramLinkIssueClosed } from "../src/github/handlers/telegram-link-issue-closed.ts";
import { CONFIG_FULL_PATH, CONFIG_ORG_REPO } from "../src/github/utils/config.ts";
import { getOrCreateTelegramLinkCode, getTelegramLinkedIdentity, saveTelegramLinkIssue } from "../src/telegram/identity-store.ts";

const TEST_ENVIRONMENT = "production" as const;
const TEST_OWNER = "test-owner";
const TEST_OWNER_TYPE = "User" as const;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const UNEXPECTED_FETCH_RESPONSE = "unexpected fetch";

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
    void options;
    const prefix = [...selector.prefix];
    const entries = this._entries
      .filter((entry) => {
        if (prefix.length > entry.key.length) return false;
        for (let i = 0; i < prefix.length; i += 1) {
          if (JSON.stringify(prefix[i]) !== JSON.stringify(entry.key[i])) {
            return false;
          }
        }
        return true;
      })
      .map((entry) => ({ key: entry.key as unknown[], value: entry.value }));

    return {
      cursor: "",
      async *[Symbol.asyncIterator]() {
        for (const entry of entries) yield entry;
      },
    };
  }
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    github: () => {},
  };
}

function createContext(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  closerLogin: string;
  ownerType: "User" | "Organization";
  octokit: unknown;
}): GitHubContext<"issues.closed"> {
  const logger = createLogger();
  return {
    id: "",
    key: "issues.closed",
    name: "issues.closed",
    payload: {
      repository: {
        name: params.repo,
        owner: { login: params.owner, type: params.ownerType },
      },
      issue: { number: params.issueNumber, state: "closed" },
      sender: { login: params.closerLogin },
    } as GitHubContext<"issues.closed">["payload"],
    logger: logger as never,
    octokit: params.octokit as never,
    eventHandler: {
      environment: TEST_ENVIRONMENT,
      logger: logger as never,
    } as never,
    llm: "",
  };
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

Deno.test("telegram link issue closed: initializes .ubiquity-os config when missing", async () => {
  const owner = TEST_OWNER;
  const issueNumber = 123;
  const telegramUserId = 42;
  const botToken = "123:abc";

  const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
  const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
    openKv?: () => Promise<unknown>;
  };
  const originalOpenKv = deno.openKv;

  const kv = new InMemoryKv();
  deno.openKv = async () => kv as unknown;

  const telegramSendBodies: Record<string, unknown>[] = [];
  const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
    const url = new URL(request.url);
    if (url.hostname === TELEGRAM_API_HOSTNAME) {
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      telegramSendBodies.push(payload ?? {});
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(UNEXPECTED_FETCH_RESPONSE, { status: 500 });
  });

  const getContentCalls: unknown[] = [];
  const createFileCalls: unknown[] = [];
  const context = createContext({
    owner,
    repo: CONFIG_ORG_REPO,
    issueNumber,
    closerLogin: owner,
    ownerType: TEST_OWNER_TYPE,
    octokit: {
      rest: {
        repos: {
          getContent: async (args: unknown) => {
            getContentCalls.push(args);
            const err = new Error("Not found") as Error & { status?: number };
            err.status = 404;
            throw err;
          },
          createOrUpdateFileContents: async (args: unknown) => {
            createFileCalls.push(args);
            return {};
          },
        },
      },
    },
  });

  const linkCode = await getOrCreateTelegramLinkCode({
    userId: telegramUserId,
    logger: createLogger(),
    now: () => 1_700_000_000_000,
  });
  assert(linkCode.ok);
  if (!linkCode.ok) return;

  const saveIssue = await saveTelegramLinkIssue({
    code: linkCode.code,
    issue: {
      owner,
      repo: CONFIG_ORG_REPO,
      issueNumber,
      issueUrl: `https://github.com/${owner}/${CONFIG_ORG_REPO}/issues/${issueNumber}`,
      createdAtMs: 1_700_000_000_000,
    },
    expiresAtMs: linkCode.expiresAtMs,
    logger: createLogger(),
  });
  assert(saveIssue.ok);

  try {
    await handleTelegramLinkIssueClosed(context, {
      ENVIRONMENT: TEST_ENVIRONMENT,
      UOS_TELEGRAM: JSON.stringify({ botToken }),
      UOS_GITHUB: "{}",
      UOS_AI: "{}",
      UOS_AGENT: "{}",
      UOS_KERNEL: "{}",
    } as never);

    assertEquals(getContentCalls.length, 1);
    assertEquals(createFileCalls.length, 1);
    assertEquals(telegramSendBodies.length, 1);

    const createArgs = createFileCalls[0] as {
      owner?: string;
      repo?: string;
      path?: string;
      message?: string;
      content?: string;
    };
    assertEquals(createArgs.owner, owner);
    assertEquals(createArgs.repo, CONFIG_ORG_REPO);
    assertEquals(createArgs.path, CONFIG_FULL_PATH);
    assertEquals(createArgs.message, "Initialize UbiquityOS config for Telegram");
    assertEquals(decodeBase64(createArgs.content ?? ""), ["plugins: {}", "channels:", "  telegram:", "    mode: shim", ""].join("\n"));

    assertEquals(telegramSendBodies[0].chat_id, telegramUserId);
    assertStringIncludes(String(telegramSendBodies[0].text ?? ""), `Linked to ${owner}`);

    const identity = await getTelegramLinkedIdentity({
      userId: telegramUserId,
      logger: createLogger(),
    });
    assert(identity.ok);
    if (identity.ok) {
      assertEquals(identity.identity?.owner, owner);
    }
  } finally {
    fetchStub.restore();
    deno.openKv = originalOpenKv;
  }
});

Deno.test("telegram link issue closed: does not overwrite existing config", async () => {
  const owner = TEST_OWNER;
  const issueNumber = 123;
  const telegramUserId = 42;
  const botToken = "123:abc";

  const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
  const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
    openKv?: () => Promise<unknown>;
  };
  const originalOpenKv = deno.openKv;

  const kv = new InMemoryKv();
  deno.openKv = async () => kv as unknown;

  const telegramSendBodies: Record<string, unknown>[] = [];
  const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
    const url = new URL(request.url);
    if (url.hostname === TELEGRAM_API_HOSTNAME) {
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      telegramSendBodies.push(payload ?? {});
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(UNEXPECTED_FETCH_RESPONSE, { status: 500 });
  });

  const createFileCalls: unknown[] = [];
  const context = createContext({
    owner,
    repo: CONFIG_ORG_REPO,
    issueNumber,
    closerLogin: owner,
    ownerType: TEST_OWNER_TYPE,
    octokit: {
      rest: {
        repos: {
          getContent: async () => ({ data: { type: "file" } }),
          createOrUpdateFileContents: async (args: unknown) => {
            createFileCalls.push(args);
            return {};
          },
        },
      },
    },
  });

  const linkCode = await getOrCreateTelegramLinkCode({
    userId: telegramUserId,
    logger: createLogger(),
    now: () => 1_700_000_000_000,
  });
  assert(linkCode.ok);
  if (!linkCode.ok) return;

  const saveIssue = await saveTelegramLinkIssue({
    code: linkCode.code,
    issue: {
      owner,
      repo: CONFIG_ORG_REPO,
      issueNumber,
      issueUrl: `https://github.com/${owner}/${CONFIG_ORG_REPO}/issues/${issueNumber}`,
      createdAtMs: 1_700_000_000_000,
    },
    expiresAtMs: linkCode.expiresAtMs,
    logger: createLogger(),
  });
  assert(saveIssue.ok);

  try {
    await handleTelegramLinkIssueClosed(context, {
      ENVIRONMENT: TEST_ENVIRONMENT,
      UOS_TELEGRAM: JSON.stringify({ botToken }),
      UOS_GITHUB: "{}",
      UOS_AI: "{}",
      UOS_AGENT: "{}",
      UOS_KERNEL: "{}",
    } as never);

    assertEquals(createFileCalls.length, 0);
    assertEquals(telegramSendBodies.length, 1);

    assertEquals(telegramSendBodies[0].chat_id, telegramUserId);
    assertStringIncludes(String(telegramSendBodies[0].text ?? ""), `Linked to ${owner}`);

    const identity = await getTelegramLinkedIdentity({
      userId: telegramUserId,
      logger: createLogger(),
    });
    assert(identity.ok);
    if (identity.ok) {
      assertEquals(identity.identity?.owner, owner);
    }
  } finally {
    fetchStub.restore();
    deno.openKv = originalOpenKv;
  }
});

Deno.test("telegram link issue closed: recovers link code from issue body when index is missing", async () => {
  const owner = TEST_OWNER;
  const issueNumber = 123;
  const telegramUserId = 42;
  const botToken = "123:abc";

  const denoAny = globalThis as unknown as { Deno?: Record<string, unknown> };
  const deno = (denoAny.Deno ?? {}) as Record<string, unknown> & {
    openKv?: () => Promise<unknown>;
  };
  const originalOpenKv = deno.openKv;

  const kv = new InMemoryKv();
  deno.openKv = async () => kv as unknown;

  const telegramSendBodies: Record<string, unknown>[] = [];
  const fetchStub = stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
    const url = new URL(request.url);
    if (url.hostname === TELEGRAM_API_HOSTNAME) {
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      telegramSendBodies.push(payload ?? {});
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(UNEXPECTED_FETCH_RESPONSE, { status: 500 });
  });

  const getContentCalls: unknown[] = [];
  const createFileCalls: unknown[] = [];

  const linkCode = await getOrCreateTelegramLinkCode({
    userId: telegramUserId,
    logger: createLogger(),
    now: () => 1_700_000_000_000,
  });
  assert(linkCode.ok);
  if (!linkCode.ok) return;

  const context = createContext({
    owner,
    repo: CONFIG_ORG_REPO,
    issueNumber,
    closerLogin: owner,
    ownerType: TEST_OWNER_TYPE,
    octokit: {
      rest: {
        issues: {
          get: async () => ({
            data: {
              body: `Code: UOS-TELEGRAM-LINK:${linkCode.code}`,
            },
          }),
        },
        repos: {
          getContent: async (args: unknown) => {
            getContentCalls.push(args);
            const err = new Error("Not found") as Error & { status?: number };
            err.status = 404;
            throw err;
          },
          createOrUpdateFileContents: async (args: unknown) => {
            createFileCalls.push(args);
            return {};
          },
        },
      },
    },
  });

  try {
    await handleTelegramLinkIssueClosed(context, {
      ENVIRONMENT: TEST_ENVIRONMENT,
      UOS_TELEGRAM: JSON.stringify({ botToken }),
      UOS_GITHUB: "{}",
      UOS_AI: "{}",
      UOS_AGENT: "{}",
      UOS_KERNEL: "{}",
    } as never);

    assertEquals(getContentCalls.length, 1);
    assertEquals(createFileCalls.length, 1);
    assertEquals(telegramSendBodies.length, 1);

    assertEquals(telegramSendBodies[0].chat_id, telegramUserId);
    assertStringIncludes(String(telegramSendBodies[0].text ?? ""), `Linked to ${owner}`);

    const identity = await getTelegramLinkedIdentity({
      userId: telegramUserId,
      logger: createLogger(),
    });
    assert(identity.ok);
    if (identity.ok) {
      assertEquals(identity.identity?.owner, owner);
    }
  } finally {
    fetchStub.restore();
    deno.openKv = originalOpenKv;
  }
});
