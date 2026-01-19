type LogTrailBucket = {
  firstTimestampMs: number;
  lastTimestampMs: number;
  lines: string[];
};

export type RequestLogTrail = {
  requestId: string;
  startedAt: string;
  durationMs: number;
  lines: string[];
};

const MAX_LINES_PER_REQUEST = 200;
const MAX_LINE_LENGTH = 800;

const REQUEST_LOG_TRAIL = Symbol("request-log-trail");

type LoggerWithTrail = {
  [REQUEST_LOG_TRAIL]?: LogTrailBucket;
};

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LINE_LENGTH - 14)}...[truncated]`;
}

export function recordRequestLog(logger: unknown, line: string) {
  if (!logger || typeof logger !== "object") return;
  const now = Date.now();
  const normalizedLine = truncateLine(line);
  const target = logger as LoggerWithTrail;
  const existing = target[REQUEST_LOG_TRAIL];
  if (existing) {
    existing.lastTimestampMs = now;
    existing.lines.push(normalizedLine);
    if (existing.lines.length > MAX_LINES_PER_REQUEST) {
      existing.lines.shift();
    }
    return;
  }

  target[REQUEST_LOG_TRAIL] = {
    firstTimestampMs: now,
    lastTimestampMs: now,
    lines: [normalizedLine],
  };
}

export function getRequestLogTrail(logger: { bindings?: () => Record<string, unknown> } | undefined): RequestLogTrail | null {
  if (!logger || typeof logger !== "object") return null;
  const requestId = readRequestIdFromLogger(logger);
  if (!requestId) return null;
  const entry = (logger as LoggerWithTrail)[REQUEST_LOG_TRAIL];
  if (!entry) return null;
  return {
    requestId,
    startedAt: new Date(entry.firstTimestampMs).toISOString(),
    durationMs: Math.max(0, entry.lastTimestampMs - entry.firstTimestampMs),
    lines: [...entry.lines],
  };
}

export function readRequestIdFromLogger(logger: { bindings?: () => Record<string, unknown> } | undefined): string | null {
  if (!logger || typeof logger.bindings !== "function") return null;
  const bindings = logger.bindings();
  const requestId = bindings?.requestId;
  return typeof requestId === "string" && requestId.trim() ? requestId : null;
}
