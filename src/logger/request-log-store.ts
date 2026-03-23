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

const MAX_REQUESTS = 120;
const MAX_LINES_PER_REQUEST = 200;
const MAX_LINE_LENGTH = 800;

const store = new Map<string, LogTrailBucket>();

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LINE_LENGTH - 14)}...[truncated]`;
}

function pruneStore() {
  while (store.size > MAX_REQUESTS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

export function recordRequestLog(requestId: string, line: string) {
  if (!requestId) return;
  const now = Date.now();
  const normalizedLine = truncateLine(line);
  const existing = store.get(requestId);
  if (existing) {
    existing.lastTimestampMs = now;
    existing.lines.push(normalizedLine);
    if (existing.lines.length > MAX_LINES_PER_REQUEST) {
      existing.lines.shift();
    }
    return;
  }

  store.set(requestId, {
    firstTimestampMs: now,
    lastTimestampMs: now,
    lines: [normalizedLine],
  });
  pruneStore();
}

export function getRequestLogTrail(requestId: string): RequestLogTrail | null {
  if (!requestId) return null;
  const entry = store.get(requestId);
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
