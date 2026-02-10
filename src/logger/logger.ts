import fs from "node:fs";
import path from "node:path";
import pino, { type DestinationStream, type Logger, type LoggerOptions, type StreamEntry } from "pino";
import pretty from "pino-pretty";
import { recordRequestLog } from "./request-log-store.ts";

const isProduction = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL || (isProduction ? "info" : "debug");
type CustomLogLevels = "github" | "local";

const redact = {
  paths: ["token", "authorization", "*.privateKey", "*.private_key", "*.app_private_key", "*.APP_PRIVATE_KEY", "*._privateKey"],
  censor: "[REDACTED]",
};

const LOG_DIR_NAME = "logs";
const LOG_FILE_PREFIX = "kernel";
const LOG_FILE_EXTENSION = "log";

function formatLogTimestamp(date: Date): string {
  function pad(value: number): string {
    return String(value).padStart(2, "0");
  }
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildLogFilePath(): string {
  const stamp = formatLogTimestamp(new Date());
  const fileName = `${LOG_FILE_PREFIX}-${stamp}.${LOG_FILE_EXTENSION}`;
  return path.join(process.cwd(), LOG_DIR_NAME, fileName);
}

function tryCreateFileStream(): DestinationStream | null {
  try {
    const logFilePath = buildLogFilePath();
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    return pino.destination({ dest: logFilePath, sync: false });
  } catch (error) {
    if (!isProduction) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[logger] File logging disabled: ${message}`);
    }
    return null;
  }
}

const LOG_ALLOWLIST_KEYS = new Set([
  "plugin",
  "manifestUrl",
  "owner",
  "repo",
  // Telegram debugging (workspace bootstrap / promotion flows).
  "chatId",
  "userId",
  "threadId",
  "messageId",
  "updateId",
  "source",
  "phase",
  "attempt",
  "description",
  "botStatus",
  "botCanPromoteMembers",
  "botUserId",
  "workflowId",
  "ref",
  "event",
  "command",
  "status",
  "issue",
  "issueNumber",
  "issue_number",
  "commentId",
  "comment_id",
  "targetRepo",
]);

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

const consoleStream: DestinationStream = isProduction
  ? pino.destination(1)
  : pretty({
      colorize: true,
      // Keep logging synchronous so `deno test` doesn't report cross-test op_write leaks.
      // (pino-pretty docs mention this for Jest; Deno test leak detection is similar.)
      sync: true,
      singleLine: false,
      levelFirst: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname,requestId",
      messageFormat: (log, messageKey) => {
        const msg = log[messageKey] as string;
        if (log.requestId) return `(${log.requestId}) ${msg}`;
        return msg;
      },
    });

const fileStream = tryCreateFileStream();
const streamEntries: StreamEntry<CustomLogLevels>[] = [{ stream: consoleStream }];

if (fileStream) {
  streamEntries.push({ stream: fileStream });
}

const stream = streamEntries.length > 1 ? pino.multistream(streamEntries) : streamEntries[0].stream;

const createLogger = pino as unknown as (options: LoggerOptions<CustomLogLevels>, stream?: DestinationStream) => Logger<CustomLogLevels>;

export const logger = createLogger(
  {
    level,
    redact,
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
            if (line) recordRequestLog(this, line);
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
