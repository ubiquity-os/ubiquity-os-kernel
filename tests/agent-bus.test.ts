import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

type KvEntry = { key: unknown[]; value: unknown };

function keyStartsWith(key: unknown[], prefix: unknown[]): boolean {
  return prefix.length <= key.length && prefix.every((value, index) => key[index] === value);
}

function normalizeKeyPart(value: unknown): string | number {
  return typeof value === "number" ? value : String(value);
}

function compareKvKey(left: unknown[], right: unknown[]): number {
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const leftValue = normalizeKeyPart(left[i]);
    const rightValue = normalizeKeyPart(right[i]);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

class InMemoryKv {
  private _entries: KvEntry[] = [];

  reset() {
    this._entries = [];
  }

  async get(key: unknown[]) {
    const found = this._entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key));
    return { value: found?.value ?? null };
  }

  async set(key: unknown[], value: unknown) {
    this._entries.push({ key: [...key], value });
    return null;
  }

  list(selector: { prefix: unknown[] }, options: { limit?: number; start?: unknown[]; cursor?: string } = {}) {
    const sorted = this._entries.filter((entry) => keyStartsWith(entry.key, selector.prefix)).sort((a, b) => compareKvKey(a.key, b.key));
    function parseCursor(raw: string) {
      if (!raw.startsWith("idx:")) return 0;
      const parsed = Number.parseInt(raw.slice(4), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }

    let startIndex = 0;
    if (options.cursor) {
      startIndex = parseCursor(options.cursor);
    } else if (options.start) {
      const index = sorted.findIndex((entry) => compareKvKey(entry.key, options.start as unknown[]) >= 0);
      startIndex = index === -1 ? sorted.length : index;
    }

    const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(0, options.limit) : sorted.length;
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

const kvStore = new InMemoryKv();
const authenticateClientMock = jest.fn<Promise<unknown>, [Request]>();

const denoStub = {
  env: {
    get: (key: string) => {
      void key;
      return undefined;
    },
  },
};

(globalThis as unknown as { Deno?: typeof denoStub }).Deno = denoStub;

jest.mock("../lib/ai.ubq.fi/src/auth.ts", () => ({
  authenticateClient: (...args: [Request]) => authenticateClientMock(...args),
}));

jest.mock("../lib/ai.ubq.fi/src/auth", () => ({
  authenticateClient: (...args: [Request]) => authenticateClientMock(...args),
}));

jest.mock("../lib/ai.ubq.fi/src/kv.ts", () => ({
  kvPromise: Promise.resolve(kvStore),
}));

jest.mock("../lib/ai.ubq.fi/src/kv", () => ({
  kvPromise: Promise.resolve(kvStore),
}));

let handleAgentMessagesList: (req: Request) => Promise<Response>;
let handleAgentMessagesPost: (req: Request) => Promise<Response>;

const githubAuth = {
  ok: true,
  token: "ghs_mock",
  method: { kind: "github_token", owner: "ubiquity-os", repo: "ubiquity-os-kernel", state_id: "state-123" },
};
const agentBusUrl = "http://localhost/v1/agent-bus";

beforeAll(async () => {
  const agentModule = await import("../lib/ai.ubq.fi/src/agent_messages.ts");
  handleAgentMessagesList = agentModule.handleAgentMessagesList;
  handleAgentMessagesPost = agentModule.handleAgentMessagesPost;
});

beforeEach(() => {
  kvStore.reset();
  authenticateClientMock.mockReset();
  authenticateClientMock.mockResolvedValue(githubAuth);
});

describe("agent message bus", () => {
  it("posts and lists messages with cursor paging", async () => {
    let now = 1_700_000_000_000;
    const dateSpy = jest.spyOn(Date, "now").mockImplementation(() => {
      now += 1;
      return now;
    });

    const first = new Request(agentBusUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-a", channel: "claims", kind: "claim", body: "first" }),
    });
    const second = new Request(agentBusUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-a", channel: "claims", kind: "claim", body: "second" }),
    });

    const postOne = await handleAgentMessagesPost(first);
    const postTwo = await handleAgentMessagesPost(second);
    expect(postOne.status).toBe(200);
    expect(postTwo.status).toBe(200);

    const listOne = await handleAgentMessagesList(new Request(`${agentBusUrl}?limit=1`));
    const listOneBody = await listOne.json();
    expect(listOneBody.messages).toHaveLength(1);
    expect(listOneBody.messages[0].body).toBe("first");
    expect(listOneBody.has_more).toBe(true);
    expect(typeof listOneBody.next_cursor).toBe("string");

    const cursor = listOneBody.next_cursor;
    const listTwo = await handleAgentMessagesList(new Request(`${agentBusUrl}?limit=1&cursor=${encodeURIComponent(cursor)}`));
    const listTwoBody = await listTwo.json();
    expect(listTwoBody.messages).toHaveLength(1);
    expect(listTwoBody.messages[0].body).toBe("second");

    dateSpy.mockRestore();
  });

  it("rejects non-github auth", async () => {
    authenticateClientMock.mockResolvedValue({
      ok: true,
      token: "ubq_ai_token",
      method: { kind: "kv_api_key", key_id: "key-1" },
    });

    const res = await handleAgentMessagesList(new Request(agentBusUrl));
    expect(res.status).toBe(403);
  });
});
