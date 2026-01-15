import type { LoggerLike } from "./kv-client.ts";
import { getEnvValue } from "./env.ts";
import { parseSupabaseConfig } from "./env-config.ts";

type VectorDbConfig = Readonly<{
  url: string;
  key: string;
}>;

export type VectorDocument = Readonly<{
  id: string;
  docType: string;
  markdown: string | null;
  embedding: number[] | null;
  authorId: number | null;
  payload: unknown | null;
}>;

export type SimilarityResult = Readonly<{
  id: string;
  similarity: number;
}>;

type FetchVectorDocumentOptions = Readonly<{
  includeEmbedding?: boolean;
}>;

type FetchVectorDocumentByParentOptions = Readonly<{
  includeEmbedding?: boolean;
  maxPerParent?: number;
  docTypes?: string[];
}>;

const warned = new Set<string>();
const VECTOR_DB_SIMILARITY_FETCH_FAILED = "Vector DB similarity fetch failed";
const DOCUMENTS_ENDPOINT = "/rest/v1/documents";

function warnOnce(logger: LoggerLike | undefined, key: string, message: string) {
  if (!logger || typeof logger.warn !== "function" || warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

function sanitizeInListValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const FETCH_TIMEOUT_MS = 10_000;

function withTimeoutSignal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

export function getVectorDbConfig(logger?: LoggerLike): VectorDbConfig | null {
  const configResult = parseSupabaseConfig(getEnvValue("UOS_SUPABASE"));
  if (!configResult.ok) {
    warnOnce(logger, "vector-db-invalid-config", configResult.error);
    return null;
  }
  if (!configResult.config) {
    if (configResult.warning) {
      warnOnce(logger, "vector-db-missing-config", `Vector DB disabled: ${configResult.warning}`);
    }
    return null;
  }
  return { url: configResult.config.url, key: configResult.config.anonKey };
}

function buildRestUrl(config: VectorDbConfig, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${config.url}${suffix}`;
}

function buildHeaders(config: VectorDbConfig): HeadersInit {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
}

function buildSelectFields(includeEmbedding: boolean): string {
  const base = ["id", "doc_type", "markdown", "author_id", "payload"];
  if (includeEmbedding) base.push("embedding");
  return base.join(",");
}

function parseVectorDocument(value: unknown): VectorDocument | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const docType = typeof record.doc_type === "string" ? record.doc_type : "";
  const markdown = typeof record.markdown === "string" ? record.markdown : null;
  let embedding: number[] | null = null;
  if (Array.isArray(record.embedding)) {
    embedding = (record.embedding as number[]).filter((n) => typeof n === "number");
  } else if (typeof record.embedding === "string") {
    try {
      const parsed = JSON.parse(record.embedding);
      if (Array.isArray(parsed)) {
        embedding = parsed.filter((n) => typeof n === "number");
      }
    } catch {
      embedding = null;
    }
  }
  let authorId: number | null = null;
  if (typeof record.author_id === "number" && Number.isFinite(record.author_id)) {
    authorId = Math.trunc(record.author_id);
  } else if (typeof record.author_id === "string") {
    const parsed = Number(record.author_id);
    if (Number.isFinite(parsed)) authorId = Math.trunc(parsed);
  }
  const payload = record.payload ?? null;
  if (!id || !docType) return null;
  return { id, docType, markdown, embedding, authorId, payload };
}

export async function fetchVectorDocument(config: VectorDbConfig, nodeId: string, logger?: LoggerLike): Promise<VectorDocument | null> {
  const id = nodeId.trim();
  if (!id) return null;
  const url = new URL(buildRestUrl(config, DOCUMENTS_ENDPOINT));
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("select", "id,doc_type,markdown,embedding,author_id,payload");
  const { signal, clear } = withTimeoutSignal();
  try {
    const res = await fetch(url.toString(), { headers: buildHeaders(config), signal });
    if (!res.ok) {
      logger?.warn?.({ status: res.status, statusText: res.statusText, nodeId: id }, "Vector DB fetch failed");
      return null;
    }
    const data = (await res.json()) as unknown[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return parseVectorDocument(data[0]);
  } catch (error) {
    logger?.warn?.({ err: error, nodeId: id }, "Vector DB fetch failed");
    return null;
  } finally {
    clear();
  }
}

export async function fetchVectorDocuments(
  config: VectorDbConfig,
  ids: string[],
  options: FetchVectorDocumentOptions = {},
  logger?: LoggerLike
): Promise<VectorDocument[]> {
  const normalized = ids.map((id) => id.trim()).filter(Boolean);
  if (normalized.length === 0) return [];
  const uniqueIds = [...new Set(normalized)];
  const chunkSize = 25;
  const results: VectorDocument[] = [];
  const select = buildSelectFields(options.includeEmbedding === true);
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const inList = chunk.map((id) => JSON.stringify(sanitizeInListValue(id))).join(",");
    const url = new URL(buildRestUrl(config, DOCUMENTS_ENDPOINT));
    url.searchParams.set("id", `in.(${inList})`);
    url.searchParams.set("select", select);
    const { signal, clear } = withTimeoutSignal();
    try {
      const res = await fetch(url.toString(), { headers: buildHeaders(config), signal });
      if (!res.ok) {
        logger?.warn?.({ status: res.status, statusText: res.statusText, chunkSize: chunk.length, chunkIndex: i }, "Vector DB batch fetch failed");
        continue;
      }
      const data = (await res.json()) as unknown[];
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        const parsed = parseVectorDocument(item);
        if (parsed) results.push(parsed);
      }
    } catch (error) {
      logger?.warn?.({ err: error, chunkSize: chunk.length, chunkIndex: i }, "Vector DB batch fetch failed");
    } finally {
      clear();
    }
  }
  return results;
}

export async function fetchVectorDocumentsByParentId(
  config: VectorDbConfig,
  parentId: string,
  options: FetchVectorDocumentByParentOptions = {},
  logger?: LoggerLike
): Promise<VectorDocument[]> {
  const parent = parentId.trim();
  if (!parent) return [];
  const url = new URL(buildRestUrl(config, DOCUMENTS_ENDPOINT));
  url.searchParams.set("parent_id", `eq.${parent}`);
  if (options.docTypes && options.docTypes.length > 0) {
    const inList = options.docTypes.map((docType) => JSON.stringify(sanitizeInListValue(docType))).join(",");
    url.searchParams.set("doc_type", `in.(${inList})`);
  }
  const select = buildSelectFields(options.includeEmbedding === true);
  url.searchParams.set("select", select);
  if (typeof options.maxPerParent === "number" && Number.isFinite(options.maxPerParent) && options.maxPerParent > 0) {
    url.searchParams.set("order", "created_at.desc");
    url.searchParams.set("limit", String(Math.trunc(options.maxPerParent)));
  }
  const { signal, clear } = withTimeoutSignal();
  try {
    const res = await fetch(url.toString(), { headers: buildHeaders(config), signal });
    if (!res.ok) {
      logger?.warn?.({ status: res.status, statusText: res.statusText, parentId: parent }, "Vector DB parent fetch failed");
      return [];
    }
    const data = (await res.json()) as unknown[];
    if (!Array.isArray(data)) return [];
    const results: VectorDocument[] = [];
    for (const item of data) {
      const parsed = parseVectorDocument(item);
      if (parsed) results.push(parsed);
    }
    return results;
  } catch (error) {
    logger?.warn?.({ err: error, parentId: parent }, "Vector DB parent fetch failed");
    return [];
  } finally {
    clear();
  }
}

export async function findSimilarIssues(
  config: VectorDbConfig,
  params: Readonly<{
    currentId: string;
    embedding: number[];
    threshold: number;
    topK: number;
  }>,
  logger?: LoggerLike
): Promise<SimilarityResult[]> {
  const currentId = params.currentId.trim();
  if (!currentId || params.embedding.length === 0) return [];
  const threshold = Number.isFinite(params.threshold) ? params.threshold : 0;
  const topK = Number.isFinite(params.topK) ? Math.max(1, Math.trunc(params.topK)) : 1;
  const url = buildRestUrl(config, "/rest/v1/rpc/find_similar_issues_annotate");
  const { signal, clear } = withTimeoutSignal();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(config),
      signal,
      body: JSON.stringify({
        current_id: currentId,
        query_embedding: params.embedding,
        threshold,
        top_k: topK,
      }),
    });
    if (!res.ok) {
      logger?.warn?.({ status: res.status, statusText: res.statusText, currentId }, VECTOR_DB_SIMILARITY_FETCH_FAILED);
      return [];
    }
    const data = (await res.json()) as Array<{ issue_id?: string; similarity?: number }> | null;
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => {
        const id = typeof row.issue_id === "string" ? row.issue_id : "";
        const similarity = typeof row.similarity === "number" && Number.isFinite(row.similarity) ? row.similarity : null;
        if (!id || similarity === null) return null;
        return { id, similarity };
      })
      .filter((row): row is SimilarityResult => Boolean(row));
  } catch (error) {
    logger?.warn?.({ err: error, currentId }, VECTOR_DB_SIMILARITY_FETCH_FAILED);
    return [];
  } finally {
    clear();
  }
}

export async function findSimilarComments(
  config: VectorDbConfig,
  params: Readonly<{
    currentId: string;
    embedding: number[];
    threshold: number;
    topK: number;
  }>,
  logger?: LoggerLike
): Promise<SimilarityResult[]> {
  const currentId = params.currentId.trim();
  if (!currentId || params.embedding.length === 0) return [];
  const threshold = Number.isFinite(params.threshold) ? params.threshold : 0;
  const topK = Number.isFinite(params.topK) ? Math.max(1, Math.trunc(params.topK)) : 1;
  const url = buildRestUrl(config, "/rest/v1/rpc/find_similar_comments_annotate");
  const { signal, clear } = withTimeoutSignal();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(config),
      signal,
      body: JSON.stringify({
        current_id: currentId,
        query_embedding: params.embedding,
        threshold,
        top_k: topK,
      }),
    });
    if (!res.ok) {
      logger?.warn?.({ status: res.status, statusText: res.statusText, currentId }, VECTOR_DB_SIMILARITY_FETCH_FAILED);
      return [];
    }
    const data = (await res.json()) as Array<{ comment_id?: string; similarity?: number }> | null;
    if (!Array.isArray(data)) return [];
    return data
      .map((row) => {
        const id = typeof row.comment_id === "string" ? row.comment_id : "";
        const similarity = typeof row.similarity === "number" && Number.isFinite(row.similarity) ? row.similarity : null;
        if (!id || similarity === null) return null;
        return { id, similarity };
      })
      .filter((row): row is SimilarityResult => Boolean(row));
  } catch (error) {
    logger?.warn?.({ err: error, currentId }, VECTOR_DB_SIMILARITY_FETCH_FAILED);
    return [];
  } finally {
    clear();
  }
}
