#!/usr/bin/env deno run --allow-net --allow-env
// dash-logs-fetcher.ts - Fetch Deno dashboard logs via the internal API.

type OutputFormat = "pretty" | "raw" | "ndjson" | "json" | "table";

interface SingleLog {
  subhosterId: string;
  deploymentId: string;
  isolateId: string;
  region: string;
  level: string;
  timestamp: string;
  message: string;
}

interface LogEntry {
  logs: SingleLog[];
  nextCursor: string | null;
}

interface Options {
  projectId: string;
  deploymentId: string;
  token: string;
  cookie: string | null;
  sinceInput: string;
  levels: string[];
  regions: string[];
  format: OutputFormat;
  decodeMessage: boolean;
  maxPages: number;
  tail: boolean;
  pollIntervalMs: number;
  limit: number | null;
  verbose: boolean;
  help: boolean;
}

interface OutputState {
  printed: number;
  collected: SingleLog[];
  lastTimestampMs: number | null;
  lastKeys: Set<string>;
}

const DEFAULT_SINCE = "1h";
const DEFAULT_POLL = "5s";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 3;

function printHelp() {
  console.log(`Usage: deno task dash-logs --project-id=ID --deployment-id=ID [options]

Fetch logs from the Deno dashboard internal API.

Required:
  --project-id=ID         Deno dashboard project ID
  --deployment-id=ID      Deployment ID

Auth:
  --token=TOKEN           Raw dashboard token (or set DENO_DEPLOY_TOKEN)
  --cookie=COOKIE         Full cookie header value (overrides --token)

Filters:
  --since=VALUE           Duration (5m, 2h, 1d) or ISO timestamp (default: 1h)
  --levels=INFO,WARN      Comma-separated log levels
  --regions=REGION1,...   Comma-separated region names

Output:
  --format=pretty|raw|ndjson|json|table  Output format (default: pretty)
  --limit=N                       Stop after N logs
  --decode-message                Parse JSON in message and render a concise summary (pretty/raw only)

Paging:
  --max-pages=N           Max pages to fetch (default: unlimited)

Tail:
  --tail                  Poll for new logs
  --poll=VALUE            Poll interval (default: 5s)

Other:
  --verbose               Progress info to stderr
  --help, -h              Show this help

Examples:
  deno task dash-logs --project-id=abc --deployment-id=def
  deno task dash-logs --project-id=abc --deployment-id=def --format=ndjson --since=30m
  deno task dash-logs --project-id=abc --deployment-id=def --tail --poll=3s
`);
}

function readArgValue(arg: string, args: string[], index: number): { value: string; nextIndex: number } {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex !== -1) {
    return { value: arg.slice(equalsIndex + 1), nextIndex: index };
  }
  if (index + 1 >= args.length) {
    throw new Error(`Missing value for ${arg}`);
  }
  return { value: args[index + 1], nextIndex: index + 1 };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseDurationMs(input: string): number | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const ms = value * multipliers[unit];
  return Number.isFinite(ms) ? ms : null;
}

function parseSince(input: string, nowMs: number): string {
  const durationMs = parseDurationMs(input);
  if (durationMs !== null) {
    return new Date(nowMs - durationMs).toISOString();
  }
  if (/^\d+(?:\.\d+)?$/.test(input.trim())) {
    const hours = Number(input);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new Error(`Invalid --since value: ${input}`);
    }
    return new Date(nowMs - hours * 3_600_000).toISOString();
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --since value: ${input}`);
  }
  return parsed.toISOString();
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    projectId: "",
    deploymentId: "",
    token: "",
    cookie: null,
    sinceInput: DEFAULT_SINCE,
    levels: [],
    regions: [],
    format: "pretty",
    decodeMessage: false,
    maxPages: Infinity,
    tail: false,
    pollIntervalMs: parseDurationMs(DEFAULT_POLL) ?? 5000,
    limit: null,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--tail") {
      options.tail = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--decode-message") {
      options.decodeMessage = true;
      continue;
    }
    if (arg.startsWith("--project-id")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.projectId = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--deployment-id")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.deploymentId = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--token")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.token = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--cookie")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.cookie = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--since")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.sinceInput = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--levels")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.levels = splitList(value);
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--regions")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      options.regions = splitList(value);
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--format")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      if (value === "pretty" || value === "raw" || value === "ndjson" || value === "json" || value === "table") {
        options.format = value;
      } else {
        throw new Error(`Invalid --format value: ${value}`);
      }
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--max-pages")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-pages value: ${value}`);
      }
      options.maxPages = parsed;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--poll")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      const parsed = parseDurationMs(value);
      if (parsed === null || parsed <= 0) {
        throw new Error(`Invalid --poll value: ${value}`);
      }
      options.pollIntervalMs = parsed;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith("--limit")) {
      const { value, nextIndex } = readArgValue(arg, args, i);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${value}`);
      }
      options.limit = parsed;
      i = nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function buildCookieHeader(options: Options): string {
  if (options.cookie) return options.cookie;
  const token = options.token || Deno.env.get("DENO_DEPLOY_TOKEN") || "";
  if (!token) {
    throw new Error("Missing auth token. Pass --token or set DENO_DEPLOY_TOKEN.");
  }
  return `token=${token}`;
}

function formatPretty(log: SingleLog, message: string): string {
  const ts = new Date(log.timestamp).toISOString();
  const level = log.level || "INFO";
  const region = log.region || "unknown";
  return `${ts} [${level}] [${region}] ${message}`;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

const TABLE_COLUMNS = ["time", "level", "event", "message", "repo", "file"] as const;

function formatTimeOnly(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return `${parsed.toISOString().slice(11, 23)} UTC`;
}

function sanitizeCell(value: string): string {
  return value.replace(/\r?\n/g, "\\n");
}

const ANSI_RESET = "\x1b[0m";
const ANSI_GREY = "\x1b[90m";

function colorCodeForLevel(level: string): string {
  const upper = level.toUpperCase();
  if (upper === "ERROR") return "\x1b[31m";
  if (upper === "WARN" || upper === "WARNING") return "\x1b[33m";
  if (upper === "INFO") return "\x1b[34m";
  if (upper === "DEBUG") return "\x1b[90m";
  return "";
}

function colorize(value: string, color: string): string {
  if (!color) return value;
  return `${color}${value}${ANSI_RESET}`;
}

function colorSeparator(value: string): string {
  return `${ANSI_GREY}${value}${ANSI_RESET}`;
}

function buildTableRow(log: SingleLog): Record<(typeof TABLE_COLUMNS)[number], string> {
  const row = {
    time: formatTimeOnly(log.timestamp),
    level: log.level || "INFO",
    event: "",
    message: "",
    repo: "",
    file: "",
  };

  const parsed = parseJsonObject(log.message);
  if (!parsed) {
    row.message = log.message;
    return row;
  }

  const msgValue = parsed.msg ?? parsed.message;
  const msg = typeof msgValue === "string" ? msgValue : "";
  const name = typeof parsed.name === "string" ? parsed.name : "";
  row.event = name;
  row.message = msg || log.message;

  const owner = typeof parsed.owner === "string" ? parsed.owner : "";
  const repo = typeof parsed.repository === "string" ? parsed.repository : "";
  row.repo = [owner, repo].filter(Boolean).join("/");

  const filePath = typeof parsed.filePath === "string" ? parsed.filePath : "";
  row.file = filePath;

  return row;
}

function renderTable(logs: SingleLog[]) {
  if (logs.length === 0) {
    console.log("No logs.");
    return;
  }

  const rows = logs.map((log) => buildTableRow(log));
  const widths = TABLE_COLUMNS.map((column) => column.length);
  for (const row of rows) {
    TABLE_COLUMNS.forEach((column, index) => {
      const value = sanitizeCell(row[column]);
      widths[index] = Math.max(widths[index], value.length);
    });
  }

  const separatorLine = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const separator = colorSeparator("|");
  const headerCells = TABLE_COLUMNS.map((column, index) => ` ${column.padEnd(widths[index])} `);
  const header = `${separator}${headerCells.join(separator)}${separator}`;

  console.log(colorSeparator(separatorLine));
  console.log(header);
  console.log(colorSeparator(separatorLine));

  for (const row of rows) {
    const rowColor = colorCodeForLevel(row.level);
    const line = `${separator}${TABLE_COLUMNS.map((column, index) => {
      const value = sanitizeCell(row[column]);
      const padded = value.padEnd(widths[index]);
      return colorize(` ${padded} `, rowColor);
    }).join(separator)}${separator}`;
    console.log(line);
  }

  console.log(colorSeparator(separatorLine));
}

function formatMessage(message: string, options: Options): string {
  if (!options.decodeMessage) return message;
  const parsed = parseJsonObject(message);
  if (!parsed) return message;

  const msgValue = parsed.msg ?? parsed.message;
  const msg = typeof msgValue === "string" ? msgValue : "";
  const name = typeof parsed.name === "string" ? parsed.name : "";

  let text = message;
  if (name && msg) {
    text = `${name}: ${msg}`;
  } else if (msg) {
    text = msg;
  } else if (name) {
    text = name;
  }

  const meta: string[] = [];
  const owner = typeof parsed.owner === "string" ? parsed.owner : "";
  const repo = typeof parsed.repository === "string" ? parsed.repository : "";
  if (owner || repo) {
    meta.push([owner, repo].filter(Boolean).join("/"));
  }
  const filePath = typeof parsed.filePath === "string" ? parsed.filePath : "";
  if (filePath) meta.push(filePath);
  const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
  if (requestId) meta.push(`rid=${requestId}`);

  if (meta.length > 0) {
    return `${text} (${meta.join(", ")})`;
  }
  return text;
}

async function fetchLogsPage(endpoint: URL, params: Record<string, unknown>, cookieHeader: string): Promise<LogEntry> {
  const url = new URL(endpoint.toString());
  url.searchParams.set("params", JSON.stringify(params));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        cookie: cookieHeader,
        "x-api-client": "true",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 500)}` : "";
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`);
  }

  const data = (await response.json()) as LogEntry;
  if (!data || !Array.isArray(data.logs)) {
    throw new Error("Unexpected response shape.");
  }
  return data;
}

function logKey(log: SingleLog): string {
  return `${log.timestamp}|${log.level}|${log.region}|${log.isolateId}|${log.message}`;
}

function shouldEmitForTail(state: OutputState, log: SingleLog): boolean {
  const ts = Date.parse(log.timestamp);
  if (!Number.isFinite(ts)) return true;
  if (state.lastTimestampMs === null || ts > state.lastTimestampMs) return true;
  if (ts < state.lastTimestampMs) return false;
  return !state.lastKeys.has(logKey(log));
}

function trackLastSeen(state: OutputState, log: SingleLog) {
  const ts = Date.parse(log.timestamp);
  if (!Number.isFinite(ts)) return;
  if (state.lastTimestampMs === null || ts > state.lastTimestampMs) {
    state.lastTimestampMs = ts;
    state.lastKeys.clear();
  }
  if (ts === state.lastTimestampMs) {
    state.lastKeys.add(logKey(log));
  }
}

function emitLogs(logs: SingleLog[], options: Options, state: OutputState, dedupe: boolean): boolean {
  for (const log of logs) {
    if (options.limit !== null && state.printed >= options.limit) return true;
    if (dedupe && !shouldEmitForTail(state, log)) {
      trackLastSeen(state, log);
      continue;
    }

    if (options.format === "json" || options.format === "table") {
      state.collected.push(log);
    } else if (options.format === "ndjson") {
      console.log(JSON.stringify(log));
    } else if (options.format === "raw") {
      const message = formatMessage(log.message, options);
      console.log(message);
    } else {
      const message = formatMessage(log.message, options);
      console.log(formatPretty(log, message));
    }

    state.printed += 1;
    trackLastSeen(state, log);
    if (options.limit !== null && state.printed >= options.limit) return true;
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(task: () => Promise<LogEntry>, verbose: boolean): Promise<LogEntry> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      if (attempt >= MAX_RETRIES) break;
      if (verbose) {
        console.error(`Retry ${attempt}/${MAX_RETRIES} after error: ${err.message}`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("Request failed.");
}

async function fetchPages(endpoint: URL, options: Options, state: OutputState, since: string, dedupe: boolean): Promise<boolean> {
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    const params = {
      since,
      levels: options.levels,
      regions: options.regions,
      ...(cursor ? { cursor } : {}),
    };

    const data = await fetchWithRetries(() => fetchLogsPage(endpoint, params, buildCookieHeader(options)), options.verbose);

    const hasHitLimit = emitLogs(data.logs, options, state, dedupe);
    page += 1;

    if (options.verbose) {
      console.error(`Fetched ${data.logs.length} logs (page ${page}/${options.maxPages === Infinity ? "inf" : options.maxPages})`);
    }

    cursor = data.nextCursor;
    if (hasHitLimit) return true;
    if (!cursor || page >= options.maxPages) return false;
  }
}

async function main() {
  const options = parseArgs(Deno.args);
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.projectId || !options.deploymentId) {
    throw new Error("Missing required --project-id or --deployment-id. Use --help for usage.");
  }

  if (options.tail && (options.format === "json" || options.format === "table")) {
    throw new Error("--tail cannot be used with --format=json or --format=table. Use --format=ndjson instead.");
  }

  const since = parseSince(options.sinceInput, Date.now());
  const endpoint = new URL(`https://dash.deno.com/_api/projects/${options.projectId}/deployments/${options.deploymentId}/query_logs`);

  const state: OutputState = {
    printed: 0,
    collected: [],
    lastTimestampMs: null,
    lastKeys: new Set(),
  };

  const hasHitLimit = await fetchPages(endpoint, options, state, since, false);
  if (options.format === "json") {
    console.log(JSON.stringify(state.collected));
  }
  if (options.format === "table") {
    renderTable(state.collected);
  }
  if (hasHitLimit || !options.tail) return;

  if (options.verbose) {
    console.error("Tailing logs. Press Ctrl+C to stop.");
  }

  while (true) {
    await sleep(options.pollIntervalMs);
    const tailSince = state.lastTimestampMs ? new Date(state.lastTimestampMs).toISOString() : parseSince("5m", Date.now());
    const hasTailHitLimit = await fetchPages(endpoint, options, state, tailSince, true);
    if (hasTailHitLimit) return;
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    Deno.exit(1);
  });
}
