type OctokitLogInfo = Record<string, unknown>;

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function buildRequestMeta(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as OctokitLogInfo;
  const meta: Record<string, unknown> = {};
  const method = readString(record.method);
  const url = readString(record.url);
  if (method) meta.method = method;
  if (url) meta.url = url;
  return Object.keys(meta).length ? meta : null;
}

export function toOctokitLogMeta(info: unknown): Record<string, unknown> | null {
  if (!info || typeof info !== "object") return null;
  const record = info as OctokitLogInfo;
  const meta: Record<string, unknown> = {};
  const method = readString(record.method);
  const url = readString(record.url);
  const status = readNumber(record.status);
  if (method) meta.method = method;
  if (url) meta.url = url;
  if (status !== null) meta.status = status;
  const request = buildRequestMeta(record.request);
  if (request) meta.request = request;
  const response = buildRequestMeta(record.response);
  if (response) meta.response = response;
  return Object.keys(meta).length ? meta : null;
}
