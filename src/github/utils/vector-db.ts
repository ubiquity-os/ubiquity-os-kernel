import type { LoggerLike } from "./kv-client";
import { getEnvValue } from "./env";

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

function warnOnce(logger: LoggerLike | undefined, key: string, message: string) {
  if (!logger || typeof logger.warn !== "function" || warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

export function getVectorDbConfig(logger?: LoggerLike): VectorDbConfig | null {
  const rawUrl = getEnvValue("UOS_VECTOR_DB_URL") ?? getEnvValue("SUPABASE_URL");
  const rawKey =
    getEnvValue("UOS_VECTOR_DB_KEY") ?? getEnvValue("SUPABASE_SERVICE_ROLE_KEY") ?? getEnvValue("SUPABASE_KEY") ?? getEnvValue("SUPABASE_ANON_KEY");
  const projectId = getEnvValue("SUPABASE_PROJECT_ID");
  const urlCandidate = rawUrl?.trim() ?? "";
  const projectIdValue = projectId?.trim() ?? "";
  let url = "";
  if (urlCandidate) {
    url = urlCandidate.replace(/\/+$/, "");
  } else if (projectIdValue) {
    url = `https://${projectIdValue}.supabase.co`;
  }
  const key = rawKey?.trim() ?? "";
  if (!url || !key) {
    warnOnce(
      logger,
      "vector-db-missing-config",
      "Vector DB disabled: missing Supabase URL/key. Set UOS_VECTOR_DB_URL/UOS_VECTOR_DB_KEY or SUPABASE_URL + SUPABASE_*_KEY (or SUPABASE_PROJECT_ID)."
    );
    return null;
  }
  return { url, key };
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

export async function fetchVectorDocument(config: VectorDbConfig, nodeId: string): Promise<VectorDocument | null> {
  const id = nodeId.trim();
  if (!id) return null;
  const url = buildRestUrl(config, `/rest/v1/documents?id=eq.${encodeURIComponent(id)}&select=id,doc_type,markdown,embedding,author_id,payload`);
  const res = await fetch(url, { headers: buildHeaders(config) });
  if (!res.ok) return null;
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return parseVectorDocument(data[0]);
}

export async function fetchVectorDocuments(config: VectorDbConfig, ids: string[], options: FetchVectorDocumentOptions = {}): Promise<VectorDocument[]> {
  const normalized = ids.map((id) => id.trim()).filter(Boolean);
  if (normalized.length === 0) return [];
  const uniqueIds = [...new Set(normalized)];
  const chunkSize = 25;
  const results: VectorDocument[] = [];
  const select = buildSelectFields(options.includeEmbedding === true);
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const inList = chunk.map((id) => `"${encodeURIComponent(id.replace(/"/g, ""))}"`).join(",");
    const url = buildRestUrl(config, `/rest/v1/documents?id=in.(${inList})&select=${select}`);
    const res = await fetch(url, { headers: buildHeaders(config) });
    if (!res.ok) continue;
    const data = (await res.json()) as unknown[];
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      const parsed = parseVectorDocument(item);
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

export async function fetchVectorDocumentsByParentId(
  config: VectorDbConfig,
  parentId: string,
  options: FetchVectorDocumentByParentOptions = {}
): Promise<VectorDocument[]> {
  const parent = parentId.trim();
  if (!parent) return [];
  const params: string[] = [];
  params.push(`parent_id=eq.${encodeURIComponent(parent)}`);
  if (options.docTypes && options.docTypes.length > 0) {
    const inList = options.docTypes.map((docType) => `"${encodeURIComponent(docType.replace(/"/g, ""))}"`).join(",");
    params.push(`doc_type=in.(${inList})`);
  }
  const select = buildSelectFields(options.includeEmbedding === true);
  params.push(`select=${select}`);
  if (typeof options.maxPerParent === "number" && Number.isFinite(options.maxPerParent) && options.maxPerParent > 0) {
    params.push("order=created_at.desc");
    params.push(`limit=${Math.trunc(options.maxPerParent)}`);
  }
  const url = buildRestUrl(config, `/rest/v1/documents?${params.join("&")}`);
  const res = await fetch(url, { headers: buildHeaders(config) });
  if (!res.ok) return [];
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data)) return [];
  const results: VectorDocument[] = [];
  for (const item of data) {
    const parsed = parseVectorDocument(item);
    if (parsed) results.push(parsed);
  }
  return results;
}

export async function findSimilarIssues(
  config: VectorDbConfig,
  params: Readonly<{
    currentId: string;
    embedding: number[];
    threshold: number;
    topK: number;
  }>
): Promise<SimilarityResult[]> {
  if (!params.currentId.trim() || params.embedding.length === 0) return [];
  const url = buildRestUrl(config, "/rest/v1/rpc/find_similar_issues_annotate");
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify({
      current_id: params.currentId,
      query_embedding: params.embedding,
      threshold: params.threshold,
      top_k: params.topK,
    }),
  });
  if (!res.ok) return [];
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
}

export async function findSimilarComments(
  config: VectorDbConfig,
  params: Readonly<{
    currentId: string;
    embedding: number[];
    threshold: number;
    topK: number;
  }>
): Promise<SimilarityResult[]> {
  if (!params.currentId.trim() || params.embedding.length === 0) return [];
  const url = buildRestUrl(config, "/rest/v1/rpc/find_similar_comments_annotate");
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify({
      current_id: params.currentId,
      query_embedding: params.embedding,
      threshold: params.threshold,
      top_k: params.topK,
    }),
  });
  if (!res.ok) return [];
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
}
