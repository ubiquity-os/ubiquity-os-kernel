import { assertEquals } from "jsr:@std/assert";

const REPOSITORY = "owner/project";
const CONFIG_PATH = ".github/.ubiquity-os.config.yml";

type StoredStatus = { value: string; expiresAt: number };
type StatusWrite = { key: string; value: string; expirationTtl: number };
type GateEnvironment = {
  APP_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
  KERNEL_URL: string;
  CONFIG_STATUS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  };
  KERNEL: { fetch(request: Request): Promise<Response> };
};

// Load the real handler at runtime because Deno does not provide Cloudflare binding globals.
const gateModuleUrl = new URL("../gate/src/index.ts", import.meta.url).href;
const { default: gate } = (await import(gateModuleUrl)) as {
  default: { fetch(request: Request, env: GateEnvironment): Promise<Response> };
};

function createHarness() {
  let now = 1_000_000;
  let configStatus = "present";
  const stored = new Map<string, StoredStatus>();
  const writes: StatusWrite[] = [];
  const reads: string[] = [];
  const forwarded: Request[] = [];
  const cache = new Map<string, Response>();
  const env: GateEnvironment = {
    APP_WEBHOOK_SECRET: "gate-test-secret",
    ENVIRONMENT: crypto.randomUUID(),
    KERNEL_URL: "https://kernel.internal",
    CONFIG_STATUS: {
      get(key) {
        reads.push(key);
        const entry = stored.get(key);
        return Promise.resolve(entry && entry.expiresAt > now ? entry.value : null);
      },
      put(key, value, { expirationTtl }) {
        writes.push({ key, value, expirationTtl });
        stored.set(key, { value, expiresAt: now + expirationTtl * 1_000 });
        return Promise.resolve();
      },
    },
    KERNEL: {
      fetch(request) {
        forwarded.push(request);
        return Promise.resolve(new Response("kernel response", { headers: { "x-uos-config": configStatus } }));
      },
    },
  };

  return {
    env,
    stored,
    writes,
    reads,
    forwarded,
    clock: () => now,
    advance(ms: number) {
      now += ms;
    },
    setStatus(status: string) {
      configStatus = status;
    },
    repoKey(repo = REPOSITORY, version = 0) {
      return `repo:${env.ENVIRONMENT}:${repo}:${version}`;
    },
    seed(key: string, value: string) {
      stored.set(key, { value, expiresAt: now + 86_400_000 });
    },
    cache: {
      async match(request: Request) {
        return cache.get(request.url)?.clone();
      },
      put(request: Request, response: Response) {
        cache.set(request.url, response.clone());
        return Promise.resolve();
      },
    },
    async send(repo = REPOSITORY, paths?: string[], isValidSignature = true) {
      const body = JSON.stringify({
        repository: { full_name: repo },
        ...(paths ? { commits: [{ modified: paths }] } : {}),
      });
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(env.APP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
      const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return gate.fetch(
        new Request("https://gate.internal/", {
          method: "POST",
          headers: { "x-github-event": paths ? "push" : "repository_dispatch", "x-hub-signature-256": `sha256=${isValidSignature ? hex : "00"}` },
          body,
        }),
        env
      );
    },
  };
}

async function withHarness(run: (harness: ReturnType<typeof createHarness>) => Promise<void>) {
  const harness = createHarness();
  const originalNow = Date.now;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Date.now = harness.clock;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: harness.cache } });
  try {
    await run(harness);
  } finally {
    Date.now = originalNow;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
}

Deno.test("gate KV writes: repeated configured events forward but persist status once", async () => {
  await withHarness(async (harness) => {
    for (let i = 0; i < 3; i++) {
      const response = await harness.send();
      assertEquals(await response.text(), "kernel response");
    }
    assertEquals(harness.forwarded.length, 3);
    assertEquals(harness.writes, [{ key: harness.repoKey(), value: "present", expirationTtl: 86_400 }]);
  });
});

Deno.test("gate KV writes: preexisting present status is not rewritten", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "present");
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.forwarded.length, 1);
    assertEquals(harness.writes.length, 0);
  });
});

Deno.test("gate KV writes: config push repairs durable absence despite stale present cache", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "present");
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.writes.length, 0);

    // Another isolate persists config removal while this isolate still caches present.
    harness.seed(harness.repoKey(), "absent");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.reads.filter((key) => key === harness.repoKey()).length, 1);
    assertEquals(harness.stored.get(harness.repoKey())?.value, "present");
    assertEquals(harness.writes, [{ key: harness.repoKey(), value: "present", expirationTtl: 86_400 }]);

    harness.advance(6 * 60_000);
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.forwarded.length, 3);
    assertEquals(harness.writes.length, 1);
  });
});

Deno.test("gate KV writes: absent status blocks until a config push changes it", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("absent");
    assertEquals((await harness.send()).status, 200);
    const blocked = await harness.send();
    assertEquals(blocked.status, 204);
    assertEquals(blocked.headers.get("x-uos-gate"), "blocked");
    assertEquals(harness.forwarded.length, 1);
    assertEquals(harness.writes.length, 1);

    harness.setStatus("present");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.forwarded.length, 2);
    assertEquals(
      harness.writes.map(({ value }) => value),
      ["absent", "present"]
    );
  });
});

Deno.test("gate KV writes: removing config persists the transition to absent", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "present");
    harness.setStatus("absent");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.writes, [{ key: harness.repoKey(), value: "absent", expirationTtl: 86_400 }]);
    assertEquals((await harness.send()).status, 204);
  });
});

Deno.test("gate KV writes: org config pushes invalidate repository status keys", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "absent");
    assertEquals((await harness.send()).status, 204);
    assertEquals((await harness.send("owner/.ubiquity-os", [CONFIG_PATH])).status, 200);
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.writes, [
      { key: `orgv:${harness.env.ENVIRONMENT}:owner`, value: "1", expirationTtl: 30 * 86_400 },
      { key: harness.repoKey("owner/.ubiquity-os", 1), value: "present", expirationTtl: 86_400 },
      { key: harness.repoKey(REPOSITORY, 1), value: "present", expirationTtl: 86_400 },
    ]);
  });
});

Deno.test("gate KV writes: unchanged traffic does not slide cache expiry and expired KV renews", async () => {
  await withHarness(async (harness) => {
    await harness.send();
    harness.advance(4 * 60_000);
    await harness.send();
    harness.advance(2 * 60_000);
    await harness.send();
    assertEquals(harness.reads.filter((key) => key === harness.repoKey()).length, 2);
    assertEquals(harness.writes.length, 1);

    harness.advance(86_400_000);
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.writes.length, 2);
    assertEquals(harness.forwarded.length, 4);
  });
});

Deno.test("gate KV writes: invalid signatures do not read, persist, or forward", async () => {
  await withHarness(async (harness) => {
    assertEquals((await harness.send(REPOSITORY, undefined, false)).status, 401);
    assertEquals(harness.reads.length, 0);
    assertEquals(harness.writes.length, 0);
    assertEquals(harness.forwarded.length, 0);
  });
});
