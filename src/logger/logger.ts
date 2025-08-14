import pino from "pino";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

const redact = {
  paths: ["token", "authorization", "*.privateKey", "*.private_key", "*.app_private_key", "*.APP_PRIVATE_KEY"],
  censor: "[REDACTED]",
};

export const logger = pino({
  level,
  redact,
  customLevels: {
    github: 15, // between debug (10) and info (20)
    local: 55, // Above all defaults, useful for debugging
  },
  useOnlyCustomLevels: false,
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: false,
            levelFirst: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
});
