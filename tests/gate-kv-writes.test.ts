import { assertEquals, assertRejects } from "jsr:@std/assert";

const REPOSITORY = "owner/project";
const CONFIG_PATH = ".github/.ubiquity-os.config.yml";
const ORGANIZATION_REPOSITORY = "owner/.ubiquity-os";
const THROTTLE_CONTROL_KEY = "throttle-control";

type StoredStatus = { value: string; expiresAt: number };
type StatusWrite = { key: string; value: string; expirationTtl?: number };
type GateEnvironment = {
  APP_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
  KERNEL_URL: string;
  CONFIG_STATUS: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  ABUSE_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
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
  let responseStatus = 200;
  const stored = new Map<string, StoredStatus>();
  const writes: StatusWrite[] = [];
  const reads: string[] = [];
  const deletes: string[] = [];
  const limited: string[] = [];
  let shouldThrottleWrites = false;
  const lastWrites = new Map<string, number>();
  const rejectedWrites: string[] = [];
  const windows = new Map<string, { start: number; count: number }>();
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
      put(key, value, options) {
        const lastWrite = lastWrites.get(key);
        if (shouldThrottleWrites && lastWrite !== undefined && now - lastWrite < 1_000) {
          rejectedWrites.push(key);
          return Promise.reject(new Error("KV PUT 429: same-key write within one second"));
        }
        lastWrites.set(key, now);
        const expirationTtl = options?.expirationTtl;
        writes.push({ key, value, expirationTtl });
        stored.set(key, { value, expiresAt: expirationTtl ? now + expirationTtl * 1_000 : Infinity });
        return Promise.resolve();
      },
      delete(key) {
        deletes.push(key);
        stored.delete(key);
        return Promise.resolve();
      },
    },
    ABUSE_RATE_LIMITER: {
      limit({ key }) {
        limited.push(key);
        const previous = windows.get(key);
        const window = previous && now - previous.start < 60_000 ? previous : { start: now, count: 0 };
        window.count += 1;
        windows.set(key, window);
        return Promise.resolve({ success: window.count <= 30 });
      },
    },
    KERNEL: {
      fetch(request) {
        forwarded.push(request);
        return Promise.resolve(new Response("kernel response", { status: responseStatus, headers: configStatus ? { "x-uos-config": configStatus } : {} }));
      },
    },
  };

  return {
    env,
    stored,
    writes,
    reads,
    deletes,
    limited,
    rejectedWrites,
    enableWriteThrottle() {
      shouldThrottleWrites = true;
    },
    forwarded,
    clock: () => now,
    advance(ms: number) {
      now += ms;
    },
    setStatus(status: string, statusCode = 200) {
      configStatus = status;
      responseStatus = statusCode;
    },
    repoKey(repo = REPOSITORY, version = 0) {
      return `repo:${env.ENVIRONMENT}:${repo}:${version}`;
    },
    ownerKey(kind: "probe" | "burst" = "probe") {
      return `owner:${env.ENVIRONMENT}:owner:${kind}`;
    },
    ownerState() {
      const probe = JSON.parse(stored.get(`owner:${env.ENVIRONMENT}:owner:probe`)?.value ?? "null");
      const burst = JSON.parse(stored.get(`owner:${env.ENVIRONMENT}:owner:burst`)?.value ?? "null");
      return probe || burst
        ? { probeStage: probe?.stage ?? 0, probeUntil: probe?.until ?? 0, burstStage: burst?.stage ?? 0, burstUntil: burst?.until ?? 0 }
        : null;
    },
    seedOwner(state: { probeStage: number; probeUntil: number; burstStage: number; burstUntil: number }) {
      stored.set(`owner:${env.ENVIRONMENT}:owner:probe`, { value: JSON.stringify({ stage: state.probeStage, until: state.probeUntil }), expiresAt: Infinity });
      stored.set(`owner:${env.ENVIRONMENT}:owner:burst`, { value: JSON.stringify({ stage: state.burstStage, until: state.burstUntil }), expiresAt: Infinity });
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
    assertEquals(harness.writes.filter(({ key }) => key === harness.repoKey()).length, 1);
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
    assertEquals(harness.writes.filter(({ key }) => key === harness.repoKey()).length, 1);

    harness.setStatus("present");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.forwarded.length, 2);
    assertEquals(
      harness.writes.filter(({ key }) => key === harness.repoKey()).map(({ value }) => value),
      ["absent", "present"]
    );
  });
});

Deno.test("gate KV writes: removing config persists the transition to absent", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "present");
    harness.setStatus("absent");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(
      harness.writes.filter(({ key }) => key === harness.repoKey()),
      [{ key: harness.repoKey(), value: "absent", expirationTtl: 86_400 }]
    );
    assertEquals((await harness.send()).status, 204);
  });
});

Deno.test("gate KV writes: org config pushes invalidate repository status keys", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "absent");
    assertEquals((await harness.send()).status, 204);
    assertEquals((await harness.send(ORGANIZATION_REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.writes, [
      { key: `orgv:${harness.env.ENVIRONMENT}:owner`, value: "1", expirationTtl: 30 * 86_400 },
      { key: harness.repoKey(ORGANIZATION_REPOSITORY, 1), value: "present", expirationTtl: 86_400 },
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

Deno.test("gate abuse: short probe cooldown counts the first 30 requests and first burst is 900 seconds", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("absent");
    await harness.send();
    for (let i = 1; i < 30; i++) assertEquals((await harness.send()).status, 204);
    assertEquals(harness.limited.length, 30);
    assertEquals(harness.ownerState()?.burstStage, 0);
    const writesBeforeBurst = harness.writes.length;
    assertEquals((await harness.send()).status, 204);
    assertEquals(harness.ownerState()?.burstUntil, harness.clock() + 900_000);
    assertEquals(harness.ownerState()?.probeStage, 1);
    assertEquals(harness.writes.length, writesBeforeBurst + 1);
    const state = harness.ownerState();
    for (let i = 0; i < 5; i++) await harness.send();
    assertEquals(harness.ownerState(), state);
    assertEquals(harness.writes.length, writesBeforeBurst + 1);
    assertEquals(harness.forwarded.length, 1);
    assertEquals(harness.reads.length, 4);
    harness.advance(900_001);
    for (let i = 0; i < 31; i++) await harness.send();
    assertEquals(harness.ownerState()?.burstUntil, harness.clock() + 1_800_000);
    assertEquals(harness.ownerState()?.probeStage, 1);
  });
});

Deno.test("gate abuse: ordinary configured traffic has no owner or limiter operations", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "present");
    harness.seedOwner({ probeStage: 4, probeUntil: 9_000_000, burstStage: 4, burstUntil: 9_000_000 });
    for (let i = 0; i < 35; i++) assertEquals((await harness.send()).status, 200);
    assertEquals(
      harness.reads.filter((key) => key.startsWith(`owner:${harness.env.ENVIRONMENT}:`)),
      []
    );
    assertEquals(harness.writes, []);
    assertEquals(harness.deletes, []);
    assertEquals(harness.limited, []);
  });
});

Deno.test("gate abuse: config push bypasses stale owner cooldown and resets once", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("absent");
    await harness.send();
    for (let i = 0; i < 30; i++) await harness.send();
    const limitCount = harness.limited.length;
    harness.setStatus("present");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.deletes, [harness.ownerKey("probe"), harness.ownerKey("burst")]);
    assertEquals(harness.ownerState(), null);
    assertEquals(harness.limited.length, limitCount);
    harness.advance(60_001);
    assertEquals((await harness.send("owner/new-project")).status, 200);
    assertEquals(harness.ownerState(), null);
  });
});

Deno.test("gate abuse: limiter outage retries unknown and absent without creating penalties", async () => {
  for (const shouldThrow of [true, false]) {
    await withHarness(async (harness) => {
      if (shouldThrow) harness.env.ABUSE_RATE_LIMITER = { limit: () => Promise.reject(new Error("unavailable")) };
      else delete harness.env.ABUSE_RATE_LIMITER;
      assertEquals((await harness.send()).status, 503);
      assertEquals(harness.writes, []);
      assertEquals(harness.forwarded, []);
      harness.seed(harness.repoKey("owner/absent"), "absent");
      assertEquals((await harness.send("owner/absent")).status, 503);
      assertEquals(harness.writes, []);
      harness.seed(harness.repoKey("owner/present"), "present");
      assertEquals((await harness.send("owner/present")).status, 200);
    });
  }
});

Deno.test("gate abuse: unknown kernel status does not establish absence or probe penalty", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("unknown");
    await harness.send();
    assertEquals(harness.writes, []);
    assertEquals(harness.ownerState(), null);
  });
});

Deno.test("gate abuse: expired probe permits new repositories and a present probe forgives owner state", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("absent");
    await harness.send();
    assertEquals(harness.ownerState()?.probeUntil, harness.clock() + 30_000);
    harness.advance(30_000);
    await harness.send("owner/second");
    assertEquals(harness.ownerState()?.probeUntil, harness.clock() + 60_000);
    assertEquals(harness.ownerState()?.burstStage, 0);
    harness.advance(60_001);
    harness.setStatus("present");
    assertEquals((await harness.send("owner/third")).status, 200);
    assertEquals(harness.ownerState(), null);
    assertEquals(harness.deletes, [harness.ownerKey("probe"), harness.ownerKey("burst")]);
  });
});

Deno.test("gate abuse: hot absent traffic has no additional KV operations", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("absent");
    await harness.send();
    const operations = [harness.reads.length, harness.writes.length, harness.deletes.length];
    for (let i = 0; i < 20; i++) await harness.send();
    assertEquals([harness.reads.length, harness.writes.length, harness.deletes.length], operations);
    assertEquals(harness.limited.length, 21);
  });
});

Deno.test("gate abuse: malformed owner state is safe and normalized owners share a limiter key", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.ownerKey(), '{"probeStage":-10,"probeUntil":1e100}');
    assertEquals((await harness.send("OWNER/Project")).status, 200);
    assertEquals(harness.limited, ["owner:0"]);
    assertEquals(
      harness.writes.filter(({ key }) => key === harness.ownerKey()),
      []
    );
  });
});

Deno.test("gate abuse: kernel errors without config status never persist absence or penalties", async () => {
  for (const status of [403, 429, 503]) {
    await withHarness(async (harness) => {
      harness.setStatus("", status);
      assertEquals((await harness.send()).status, status);
      assertEquals(harness.writes, []);
      assertEquals(harness.ownerState(), null);
    });
  }
  await withHarness(async (harness) => {
    harness.env.KERNEL.fetch = () => Promise.reject(new Error("kernel unavailable"));
    await assertRejects(() => harness.send(), Error, "kernel unavailable");
    assertEquals(harness.writes, []);
  });
});

Deno.test("gate abuse: config push recovers even when the limiter is unavailable", async () => {
  await withHarness(async (harness) => {
    harness.seed(harness.repoKey(), "absent");
    harness.seedOwner({ probeStage: 9, probeUntil: 9_000_000, burstStage: 9, burstUntil: 9_000_000 });
    delete harness.env.ABUSE_RATE_LIMITER;
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.deletes, [harness.ownerKey("probe"), harness.ownerKey("burst")]);
    assertEquals(harness.ownerState(), null);
    assertEquals(harness.stored.get(harness.repoKey())?.value, "present");
  });
});

Deno.test("gate abuse: throttled per-key PUTs preserve an immediate first burst for 900 seconds", async () => {
  await withHarness(async (harness) => {
    harness.enableWriteThrottle();
    // Negative control: the mock must reject a second same-key PUT at the same clock time.
    await harness.env.CONFIG_STATUS.put(THROTTLE_CONTROL_KEY, "first");
    await assertRejects(() => harness.env.CONFIG_STATUS.put(THROTTLE_CONTROL_KEY, "second"), Error, "KV PUT 429");
    harness.setStatus("absent");
    for (let i = 0; i < 31; i++) await harness.send();
    assertEquals(harness.rejectedWrites, [THROTTLE_CONTROL_KEY]);
    assertEquals(harness.ownerState()?.probeStage, 1);
    assertEquals(harness.ownerState()?.burstUntil, harness.clock() + 900_000);
    assertEquals(harness.writes.filter(({ key }) => key === harness.ownerKey("probe")).length, 1);
    assertEquals(harness.writes.filter(({ key }) => key === harness.ownerKey("burst")).length, 1);
    harness.advance(60_001);
    harness.setStatus("present");
    assertEquals((await harness.send("owner/new-project")).status, 204);
    assertEquals(harness.ownerState()?.burstStage, 1);
    assertEquals(harness.forwarded.length, 1);
  });
});

Deno.test("gate abuse: repeated unknown repository misses are cached during owner cooldown and expire", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("absent");
    for (let i = 0; i < 31; i++) await harness.send();
    const repo = "owner/unknown-project";
    for (let i = 0; i < 20; i++) assertEquals((await harness.send(repo)).status, 204);
    assertEquals(harness.reads.filter((key) => key === harness.repoKey(repo)).length, 1);
    assertEquals(harness.stored.has(harness.repoKey(repo)), false);
    assertEquals(harness.forwarded.length, 1);
    // Another isolate discovers present; the miss sentinel must expire at 30s despite a long owner cooldown.
    harness.seed(harness.repoKey(repo), "present");
    harness.setStatus("present");
    harness.advance(30_001);
    assertEquals((await harness.send(repo)).status, 200);
    assertEquals(harness.reads.filter((key) => key === harness.repoKey(repo)).length, 2);
    assertEquals(harness.forwarded.length, 2);
  });
});

Deno.test("gate abuse: a cached KV miss still permits ordinary kernel probes and immediate config recovery", async () => {
  await withHarness(async (harness) => {
    harness.setStatus("unknown");
    for (let i = 0; i < 2; i++) assertEquals((await harness.send()).status, 200);
    assertEquals(harness.reads.filter((key) => key === harness.repoKey()).length, 1);
    assertEquals(harness.forwarded.length, 2);
    assertEquals(harness.writes, []);
    harness.setStatus("present");
    assertEquals((await harness.send(REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.stored.get(harness.repoKey())?.value, "present");
    assertEquals(harness.deletes, [harness.ownerKey("probe"), harness.ownerKey("burst")]);
  });
});

Deno.test("gate abuse: organization config push starts a fresh native limiter bucket immediately", async () => {
  await withHarness(async (harness) => {
    harness.enableWriteThrottle();
    harness.setStatus("absent");
    for (let i = 0; i < 31; i++) await harness.send();
    harness.setStatus("present");
    assertEquals((await harness.send(ORGANIZATION_REPOSITORY, [CONFIG_PATH])).status, 200);
    assertEquals(harness.ownerState(), null);
    assertEquals(harness.deletes, [harness.ownerKey("probe"), harness.ownerKey("burst")]);
    assertEquals((await harness.send()).status, 200);
    assertEquals(harness.limited.at(-1), "owner:1");
    assertEquals(harness.limited.filter((key) => key === "owner:0").length, 31);
    assertEquals(harness.rejectedWrites, []);
    assertEquals(harness.ownerState(), null);
  });
});
