import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import pretty from "pino-pretty";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");
type CustomLogLevels = "github" | "local";

const redact = {
  paths: ["token", "authorization", "*.privateKey", "*.private_key", "*.app_private_key", "*.APP_PRIVATE_KEY", "*._privateKey"],
  censor: "[REDACTED]",
};

const stream =
  process.env.NODE_ENV !== "production"
    ? pretty({
        colorize: true,
        singleLine: false,
        levelFirst: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname,requestId",
        messageFormat: (log, messageKey) => {
          const msg = log[messageKey] as string;
          if (log.requestId) return `(${log.requestId}) ${msg}`;
          return msg;
        },
      })
    : undefined;

const createLogger = pino as unknown as (options: LoggerOptions<CustomLogLevels>, stream?: DestinationStream) => Logger<CustomLogLevels>;

export const logger = createLogger(
  {
    level,
    redact,
    customLevels: {
      github: 15, // between debug (10) and info (20)
      local: 55, // Above all defaults, useful for debugging
    },
  },
  stream
);
