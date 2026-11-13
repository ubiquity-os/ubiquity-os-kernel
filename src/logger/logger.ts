import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { recordRequestLog } from "./request-log-store.ts";

const level = "info";
type CustomLogLevels = "github" | "local";
const textDecoder = new TextDecoder();

const redact = {
  paths: ["token", "authorization", "*.privateKey", "*.private_key", "*.app_private_key", "*.APP_PRIVATE_KEY", "*._privateKey"],
  censor: "[REDACTED]",
};

const LOG_ALLOWLIST_KEYS = new Set([
  "plugin",
  "manifestUrl",
  "owner",
  "repo",
  "workflowId",
  "ref",
  "event",
  "deliveryId",
  "repository",
  "command",
  "status",
  "issue",
  "issueNumber",
  "issue_number",
  "commentId",
  "comment_id",
  "targetRepo",
]);

// Bounded retention of AggregateError inner diagnostics. The count bound matches
// serializeError; the per-stack cap keeps a pathological aggregation from
// inflating a Workers log line.
const BROWSER_INNER_ERROR_LIMIT = 5;
const INNER_STACK_LIMIT = 2048;

function summarizeError(error: unknown) {
  if (!error || typeof error !== "object") return { type: typeof error, message: String(error) };
  const detail = error as { name?: unknown; type?: unknown; message?: unknown; stack?: unknown };
  const typeName = typeof detail.name === "string" ? detail.name : typeof detail.type === "string" ? detail.type : "Error";
  return {
    type: typeName,
    message: typeof detail.message === "string" ? detail.message : "Unknown error",
    ...(typeof detail.stack === "string" ? { stack: detail.stack.slice(0, INNER_STACK_LIMIT) } : {}),
  };
}

function serializeError(error: unknown) {
  const detail = summarizeError(error);
  return error instanceof AggregateError ? { ...detail, errors: error.errors.slice(0, BROWSER_INNER_ERROR_LIMIT).map(summarizeError) } : detail;
}

// Pino's browser build serializes a BARE Error with its built-in `stdSerializers.err`,
// which copies extra fields with `for...in`. `AggregateError.prototype.errors` is an own
// but NON-ENUMERABLE property, so `for...in` never visits it and the originating inner
// stacks are discarded before any logger-level serializer runs. Measured on pino 9.0.0
// browser.js: Object.getOwnPropertyNames -> ["stack","message","errors"], for...in -> [].
// Routing the bare path through the same bounded summariser keeps the outer diagnostic
// and the inner messages/stacks, and drops everything else exactly as before.
//
// The published type for `stdSerializers.err` describes the NODE serializer, which also
// attaches `raw: Error`. The browser implementation returns only {type,msg,stack}. We
// deliberately do NOT satisfy `raw`: attaching the raw error object is precisely what the
// credential-redaction work removed, so the cast records the type mismatch instead.
//
// Exported so the browser-path regression test wires the SAME function into the browser
// build that the Workers bundle resolves `pino` to, instead of re-implementing it.
export function installBoundedErrorSerializer(target: typeof pino) {
  target.stdSerializers.err = serializeError as unknown as typeof pino.stdSerializers.err;
}

installBoundedErrorSerializer(pino);

function boundedInnerErrors(value: unknown) {
  if (!Array.isArray(value)) return null;
  const bounded = value.slice(0, BROWSER_INNER_ERROR_LIMIT).map(summarizeError);
  return bounded.length ? bounded : null;
}

export function serializeBrowserLog(record: Record<string, unknown>) {
  // Pino's browser serializer copies custom fields from bare Errors before formatting.
  if (typeof record.type !== "string") return record;
  const safe: Record<string, unknown> = {};
  const keys = ["time", "level", "msg", "type", "stack", "requestId", "name", "instigator", ...LOG_ALLOWLIST_KEYS];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  // Only the bounded, already-summarised inner diagnostics are allowed through: plain
  // {type,message,stack} primitives, never arbitrary objects, transformed GitHubContext
  // values, runtime configuration or secret fragments.
  const inner = boundedInnerErrors(record.errors);
  if (inner) safe.errors = inner;
  return safe;
}

function safeToLogValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function extractLogMessage(args: unknown[]) {
  if (!args.length) return { msg: "", meta: null as Record<string, unknown> | null, err: null as Error | null };
  const first = args[0];
  const second = args[1];

  if (first instanceof Error) {
    return {
      msg: typeof second === "string" ? second : first.message,
      meta: null,
      err: first,
    };
  }

  if (typeof first === "string") {
    return { msg: first, meta: null, err: null };
  }

  if (first && typeof first === "object") {
    const msg = typeof second === "string" ? second : "";
    return { msg, meta: first as Record<string, unknown>, err: null };
  }

  return { msg: String(first), meta: null, err: null };
}

function formatLogLine(level: string, args: unknown[], bindings: Record<string, unknown>): string {
  const { msg, meta, err } = extractLogMessage(args);
  const extras: string[] = [];

  if (bindings?.name) {
    const value = safeToLogValue(bindings.name);
    if (value) extras.push(`name=${value}`);
  }
  if (bindings?.instigator) {
    const value = safeToLogValue(bindings.instigator);
    if (value) extras.push(`instigator=${value}`);
  }

  if (meta) {
    for (const key of LOG_ALLOWLIST_KEYS) {
      if (Object.prototype.hasOwnProperty.call(meta, key)) {
        const value = safeToLogValue(meta[key]);
        if (value) extras.push(`${key}=${value}`);
      }
    }
    const metaErr = meta.err;
    if (metaErr instanceof Error) {
      const errMessage = safeToLogValue(metaErr.message);
      if (errMessage) extras.push(`err="${errMessage}"`);
    } else if (metaErr && typeof metaErr === "object") {
      const errMessage = safeToLogValue((metaErr as { message?: unknown }).message);
      if (errMessage) extras.push(`err="${errMessage}"`);
    }
    const status = safeToLogValue((meta as { status?: unknown }).status);
    if (status) extras.push(`status=${status}`);
  }

  if (err) {
    const errMessage = safeToLogValue(err.message);
    if (errMessage) extras.push(`err="${errMessage}"`);
  }

  const base = [level.toUpperCase(), msg].filter(Boolean).join(" ").trim();
  if (!extras.length) return base;
  if (!base) return extras.join(" ");
  return `${base} | ${extras.join(" ")}`;
}

function normalizeChunk(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") return chunk;
  return textDecoder.decode(chunk);
}

function selectConsoleMethod(level: unknown) {
  if (typeof level === "number") {
    if (level >= 50) return console.error;
    if (level >= 40) return console.warn;
    if (level >= 30) return console.info;
  }
  return console.log;
}

function createConsoleSyncStream(): DestinationStream {
  return {
    write(chunk) {
      const line = normalizeChunk(chunk).replace(/[\r\n]+$/u, "");
      if (!line) return true;
      try {
        const parsed = JSON.parse(line) as { level?: unknown };
        selectConsoleMethod(parsed.level).call(console, JSON.stringify(parsed));
      } catch {
        // Fall back to the raw line for non-JSON or partially written chunks.
        console.log(line);
      }
      return true;
    },
  } as DestinationStream;
}

const stream = createConsoleSyncStream();

const createLogger = pino as unknown as (options: LoggerOptions<CustomLogLevels>, stream?: DestinationStream) => Logger<CustomLogLevels>;

export const logger = createLogger(
  {
    level,
    redact,
    serializers: { err: serializeError },
    browser: {
      serialize: true,
      write(record) {
        const safe = serializeBrowserLog(record as Record<string, unknown>);
        selectConsoleMethod(safe.level).call(console, JSON.stringify(safe));
      },
    },
    hooks: {
      logMethod(args, method, level) {
        try {
          const bindings = typeof this.bindings === "function" ? this.bindings() : {};
          const requestId = typeof bindings?.requestId === "string" ? bindings.requestId : "";
          if (requestId) {
            let levelLabel = "";
            if (typeof level === "string") {
              levelLabel = level;
            } else if (typeof this.levels?.labels?.[level] === "string") {
              levelLabel = this.levels.labels[level];
            } else {
              levelLabel = String(level);
            }
            const line = formatLogLine(levelLabel, args, bindings as Record<string, unknown>);
            if (line) recordRequestLog(requestId, line);
          }
        } catch {
          // Avoid logging failures impacting primary flow.
        }
        return method.apply(this, args);
      },
    },
    customLevels: {
      github: 15, // between debug (10) and info (20)
      local: 55, // Above all defaults, useful for debugging
    },
  },
  stream
);
