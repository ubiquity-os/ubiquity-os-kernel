import pinoBrowser from "npm:pino@9.0.0/browser.js";
import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";
import { installBoundedErrorSerializer, serializeBrowserLog } from "../src/logger/logger.ts";

// Regression coverage for ubiquity-os/ubiquity-os-kernel#371.
//
// The Workers runtime resolves `pino` to its BROWSER build, which is a different code path
// from the Node build the other logger tests exercise. In the browser build a BARE Error is
// serialized by pino's built-in `stdSerializers.err`, whose field copy uses `for...in`.
// `AggregateError.prototype.errors` is an own but non-enumerable property, so `for...in`
// never visits it and the originating inner messages/stacks are discarded before the
// logger's own serializer can see them. These tests drive the browser build directly.

const PRIVATE_KEY = "uos-test-private-key-sentinel";
const WEBHOOK_SECRET = "uos-test-webhook-secret-sentinel";
const INNER_MESSAGE = "inner failure";
const OUTER_MESSAGE = "outer failure";

type BrowserLogger = {
  error: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => BrowserLogger;
};

function createBrowserLogger() {
  // Wire the production summariser into the browser build exactly as the Workers bundle
  // does when it resolves `pino` to browser.js. Reusing the exported installer means this
  // test fails if that wiring is removed from the logger module.
  installBoundedErrorSerializer(pinoBrowser as unknown as typeof import("pino"));
  const lines: string[] = [];
  const logger = (pinoBrowser as unknown as (opts: unknown) => BrowserLogger)({
    level: "info",
    serializers: { err: (value: unknown) => value },
    browser: {
      serialize: true,
      write(record: unknown) {
        lines.push(JSON.stringify(serializeBrowserLog(record as Record<string, unknown>)));
      },
    },
  });
  return { logger, lines };
}

function parseLines(lines: string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

Deno.test("browser build keeps outer and bounded inner diagnostics for a bare AggregateError", () => {
  const { logger, lines } = createBrowserLogger();
  const inner = Object.assign(new Error(INNER_MESSAGE), {
    context: { eventHandler: { _privateKey: PRIVATE_KEY } },
    request: { headers: { authorization: WEBHOOK_SECRET } },
  });
  logger.error(new AggregateError([inner], OUTER_MESSAGE), "Uncaught aggregate error");

  assertEquals(lines.length, 1);
  const record = parseLines(lines)[0];

  // Outer diagnostic survives.
  assertEquals(record.type, "AggregateError");
  assertStringIncludes(String(record.stack), OUTER_MESSAGE);
  assertEquals(record.msg, "Uncaught aggregate error");

  // Inner diagnostics survive, bounded, with their own stacks.
  const errors = record.errors as Array<Record<string, unknown>>;
  assertExists(errors, "bounded inner errors must be retained");
  assertEquals(errors.length, 1);
  assertEquals(errors[0].message, INNER_MESSAGE);
  assertStringIncludes(String(errors[0].stack), INNER_MESSAGE);

  // Credential redaction still holds: the attached runtime context never reaches the log.
  const text = JSON.stringify(record);
  assertEquals(text.includes(PRIVATE_KEY), false);
  assertEquals(text.includes(WEBHOOK_SECRET), false);
  assertEquals(text.includes("eventHandler"), false);
});

Deno.test("browser build bounds the retained inner diagnostics", () => {
  const { logger, lines } = createBrowserLogger();
  const inner = Array.from({ length: 8 }, (_, index) => new Error(`${INNER_MESSAGE} ${index}`));
  logger.error(new AggregateError(inner, OUTER_MESSAGE), "Uncaught aggregate error");

  const record = parseLines(lines)[0];
  const errors = record.errors as Array<Record<string, unknown>>;
  assertExists(errors);
  assertEquals(errors.length, 5, "inner diagnostics are capped at five");
  assertEquals(errors[4].message, `${INNER_MESSAGE} 4`);
});

Deno.test("browser build keeps ordinary errors unchanged and drops unlisted metadata", () => {
  const { logger, lines } = createBrowserLogger();
  logger.error(new Error(INNER_MESSAGE), "Plain failure");
  const plain = parseLines(lines)[0];
  assertEquals(plain.type, "Error");
  assertEquals(plain.errors, undefined);
  assertEquals(plain.msg, "Plain failure");

  // Allowlist discipline: only the bounded, sanitised inner summaries may pass through as
  // non-scalars. Arbitrary attached objects (transformed GitHubContext values, runtime
  // configuration) must not be serialized.
  const hostile = {
    time: 1,
    level: 50,
    type: "AggregateError",
    stack: "stack",
    errors: [{ message: "kept", stack: "s" }],
    plugin: "kept-plugin",
    githubContext: { token: PRIVATE_KEY },
    errorsArbitrary: [{ deep: { secret: PRIVATE_KEY } }],
  } as Record<string, unknown>;
  const safe = serializeBrowserLog(hostile);
  assertExists(safe.errors);
  assertEquals(JSON.stringify(safe).includes(PRIVATE_KEY), false);
  assertEquals(safe.githubContext, undefined);
  assertEquals(safe.errorsArbitrary, undefined);
  assertEquals(safe.plugin, "kept-plugin");
});
