import { UndirectedGraph } from "graphology";
import { GitHubContext } from "../github-context";
import { getKvClient, type KvKey, type KvLike, type LoggerLike } from "./kv-client";

type ConversationNodeType = "Issue" | "PullRequest";

export type ConversationNode = Readonly<{
  id: string;
  type: ConversationNodeType;
  createdAt: string;
  url: string;
  owner: string;
  repo: string;
  number?: number;
  title?: string;
}>;

type ConversationNodeRecord = ConversationNode & Readonly<{ key: string; updatedAt: string }>;

type ConversationSnapshot = Readonly<{
  root: ConversationNode;
  linked: ConversationNode[];
}>;

export type ConversationKeyResult = Readonly<{
  key: string;
  root: ConversationNode;
  linked: ConversationNode[];
}>;

type GraphqlRequest = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

const KV_ROOT: KvKey = ["ubiquityos", "agent", "conversation"];
const LIST_PAGE_SIZE = 200;
const MAX_ALIAS_DEPTH = 6;
const TIMELINE_PAGE_SIZE = 100;
const CLOSING_PAGE_SIZE = 50;

const aliasCache = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return undefined;
}

function nodeKey(nodeId: string): KvKey {
  return [...KV_ROOT, "node", nodeId];
}

function aliasKey(key: string): KvKey {
  return [...KV_ROOT, "alias", key];
}

function keyNodesPrefix(key: string): KvKey {
  return [...KV_ROOT, "key", key, "nodes"];
}

function keyNodeKey(key: string, nodeId: string): KvKey {
  return [...keyNodesPrefix(key), nodeId];
}

function parseNodeRecord(value: unknown): ConversationNodeRecord | null {
  if (!isRecord(value)) return null;
  const id = normalizeString(value.id);
  const key = normalizeString(value.key);
  const type = normalizeString(value.type) as ConversationNodeType;
  const createdAt = normalizeString(value.createdAt);
  const url = normalizeString(value.url);
  const owner = normalizeString(value.owner);
  const repo = normalizeString(value.repo);
  if (!id || !key || !type || !createdAt || !url || !owner || !repo) return null;
  const number = normalizeNumber(value.number);
  const title = normalizeString(value.title) || undefined;
  const updatedAt = normalizeString(value.updatedAt) || new Date().toISOString();
  return {
    id,
    key,
    type,
    createdAt,
    url,
    owner,
    repo,
    number,
    title,
    updatedAt,
  };
}

function parseConversationNode(value: unknown): ConversationNode | null {
  if (!isRecord(value)) return null;
  const type = normalizeString(value.__typename) as ConversationNodeType;
  if (type !== "Issue" && type !== "PullRequest") return null;
  const id = normalizeString(value.id);
  const createdAt = normalizeString(value.createdAt);
  const url = normalizeString(value.url);
  let owner = "";
  let repo = "";
  if (isRecord(value.repository)) {
    const repoName = normalizeString(value.repository.name);
    const ownerLogin = isRecord(value.repository.owner) ? normalizeString(value.repository.owner.login) : "";
    owner = ownerLogin;
    repo = repoName;
  }
  if ((!owner || !repo) && url) {
    const parsed = parseOwnerRepoFromUrl(url);
    owner = owner || parsed.owner;
    repo = repo || parsed.repo;
  }
  if (!id || !createdAt || !url || !owner || !repo) return null;
  const number = normalizeNumber(value.number);
  const title = normalizeString(value.title) || undefined;
  return {
    id,
    type,
    createdAt,
    url,
    owner,
    repo,
    number,
    title,
  };
}

function parseOwnerRepoFromUrl(url: string): { owner: string; repo: string } {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    return { owner: "", repo: "" };
  }
  return { owner: "", repo: "" };
}

function getGraphqlClient(context: GitHubContext): GraphqlRequest | null {
  const octokit = context.octokit as {
    graphql?: GraphqlRequest;
    request?: (route: string, options?: Record<string, unknown>) => Promise<{ data?: unknown }>;
  };
  if (typeof octokit.graphql === "function") {
    return octokit.graphql;
  }
  const request = octokit.request;
  if (typeof request !== "function") {
    return null;
  }
  return async (query: string, variables?: Record<string, unknown>) => {
    const response = await request("POST /graphql", { query, variables });
    return (response as { data?: unknown }).data ?? response;
  };
}

async function fetchConversationSnapshot(context: GitHubContext, nodeId: string): Promise<ConversationSnapshot | null> {
  const graphql = getGraphqlClient(context);
  if (!graphql) return null;
  try {
    const data = (await graphql(
      `
        query ($nodeId: ID!, $timelineCount: Int!, $closingCount: Int!) {
          node(id: $nodeId) {
            __typename
            ... on Issue {
              id
              number
              title
              url
              createdAt
              repository {
                name
                owner {
                  login
                }
              }
              timelineItems(first: $timelineCount, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
                nodes {
                  ... on CrossReferencedEvent {
                    source {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                    subject {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                  }
                  ... on ConnectedEvent {
                    source {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                    subject {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                  }
                }
              }
            }
            ... on PullRequest {
              id
              number
              title
              url
              createdAt
              repository {
                name
                owner {
                  login
                }
              }
              closingIssuesReferences(first: $closingCount) {
                nodes {
                  __typename
                  id
                  number
                  title
                  url
                  createdAt
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                }
              }
              timelineItems(first: $timelineCount, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
                nodes {
                  ... on CrossReferencedEvent {
                    source {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                    subject {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                  }
                  ... on ConnectedEvent {
                    source {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                    subject {
                      __typename
                      id
                      number
                      title
                      url
                      createdAt
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        nodeId,
        timelineCount: TIMELINE_PAGE_SIZE,
        closingCount: CLOSING_PAGE_SIZE,
      }
    )) as {
      node?: Record<string, unknown>;
    };

    const root = parseConversationNode(data.node);
    if (!root) return null;

    const linked: ConversationNode[] = [];
    const timelineItems = isRecord(data.node?.timelineItems) ? data.node?.timelineItems : null;
    if (timelineItems && Array.isArray(timelineItems.nodes)) {
      for (const item of timelineItems.nodes) {
        if (!isRecord(item)) continue;
        for (const candidate of [item.source, item.subject]) {
          const parsed = parseConversationNode(candidate);
          if (parsed && parsed.id !== root.id) linked.push(parsed);
        }
      }
    }

    if (isRecord(data.node?.closingIssuesReferences) && Array.isArray(data.node?.closingIssuesReferences.nodes)) {
      for (const node of data.node?.closingIssuesReferences.nodes ?? []) {
        const parsed = parseConversationNode(node);
        if (parsed && parsed.id !== root.id) linked.push(parsed);
      }
    }

    return { root, linked };
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to fetch conversation links (non-fatal)");
    return null;
  }
}

async function getSubjectNode(context: GitHubContext): Promise<ConversationNode | null> {
  const payload = context.payload as Record<string, unknown>;
  const repository = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
  const owner = normalizeString(repository?.owner?.login);
  const repo = normalizeString(repository?.name);

  if ("pull_request" in payload && isRecord(payload.pull_request)) {
    const pr = payload.pull_request as Record<string, unknown>;
    const node = parseConversationNode({
      __typename: "PullRequest",
      id: pr.node_id,
      number: pr.number,
      title: pr.title,
      url: pr.html_url ?? pr.url,
      createdAt: pr.created_at,
      repository: { name: repo, owner: { login: owner } },
    });
    if (node) return node;
  }

  if ("issue" in payload && isRecord(payload.issue)) {
    const issue = payload.issue as Record<string, unknown>;
    const isPullRequest = Boolean(issue.pull_request);
    if (isPullRequest && owner && repo && typeof issue.number === "number") {
      try {
        const { data } = await context.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number,
        });
        const node = parseConversationNode({
          __typename: "PullRequest",
          id: data.node_id,
          number: data.number,
          title: data.title,
          url: data.html_url ?? data.url,
          createdAt: data.created_at,
          repository: { name: repo, owner: { login: owner } },
        });
        if (node) return node;
      } catch (error) {
        context.logger.debug({ err: error }, "Failed to hydrate PR node for issue comment (non-fatal)");
      }
    }

    const node = parseConversationNode({
      __typename: "Issue",
      id: issue.node_id,
      number: issue.number,
      title: issue.title,
      url: issue.html_url ?? issue.url,
      createdAt: issue.created_at,
      repository: { name: repo, owner: { login: owner } },
    });
    if (node) return node;
  }

  return null;
}

async function resolveAliasKey(kv: KvLike, key: string): Promise<string> {
  if (aliasCache.has(key)) return aliasCache.get(key) ?? key;
  let current = key;
  for (let i = 0; i < MAX_ALIAS_DEPTH; i += 1) {
    const { value } = await kv.get(aliasKey(current));
    const next = normalizeString(value);
    if (!next) break;
    current = next;
  }
  aliasCache.set(key, current);
  return current;
}

async function getNodeRecord(kv: KvLike, nodeId: string): Promise<ConversationNodeRecord | null> {
  const { value } = await kv.get(nodeKey(nodeId));
  return parseNodeRecord(value);
}

function pickCanonicalNode(nodes: ConversationNode[]): ConversationNode {
  return [...nodes].sort((a, b) => compareNodes(a, b))[0] ?? nodes[0];
}

function compareNodes(a: ConversationNode, b: ConversationNode): number {
  const typeRank = (node: ConversationNode) => (node.type === "Issue" ? 0 : 1);
  const rankDiff = typeRank(a) - typeRank(b);
  if (rankDiff !== 0) return rankDiff;
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  const aScore = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
  const bScore = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
  if (aScore !== bScore) return aScore - bScore;
  return a.id.localeCompare(b.id);
}

async function listNodesForKey(kv: KvLike, key: string): Promise<string[]> {
  const prefix = keyNodesPrefix(key);
  const nodeIds: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const iterator = kv.list({ prefix }, { limit: LIST_PAGE_SIZE, cursor });
      for await (const entry of iterator) {
        const parts = entry.key;
        const nodeId = parts[parts.length - 1];
        if (typeof nodeId === "string" && nodeId.trim()) nodeIds.push(nodeId);
      }
      cursor = iterator.cursor ? String(iterator.cursor) : "";
    } while (cursor);
  } catch {
    return nodeIds;
  }
  return nodeIds;
}

async function persistNode(kv: KvLike, node: ConversationNode, key: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const record: ConversationNodeRecord = { ...node, key, updatedAt };
  await kv.set(nodeKey(node.id), record);
  await kv.set(keyNodeKey(key, node.id), 1);
}

async function mergeKeys(kv: KvLike, fromKey: string, toKey: string): Promise<void> {
  if (fromKey === toKey) return;
  await kv.set(aliasKey(fromKey), toKey);
  const nodeIds = await listNodesForKey(kv, fromKey);
  for (const nodeId of nodeIds) {
    const record = await getNodeRecord(kv, nodeId);
    if (!record) continue;
    await persistNode(
      kv,
      { ...record, id: nodeId, type: record.type, createdAt: record.createdAt, url: record.url, owner: record.owner, repo: record.repo },
      toKey
    );
  }
}

function buildGraph(root: ConversationNode, linked: ConversationNode[]): UndirectedGraph {
  const graph = new UndirectedGraph();
  graph.addNode(root.id, root);
  for (const node of linked) {
    if (!graph.hasNode(node.id)) graph.addNode(node.id, node);
    if (!graph.hasEdge(root.id, node.id)) {
      graph.addEdge(root.id, node.id);
    }
  }
  return graph;
}

function dedupeNodes(nodes: ConversationNode[]): ConversationNode[] {
  const seen = new Set<string>();
  const out: ConversationNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

export async function resolveConversationKeyForContext(context: GitHubContext, logger?: LoggerLike): Promise<ConversationKeyResult | null> {
  const subject = await getSubjectNode(context);
  if (!subject) return null;

  const snapshot = (await fetchConversationSnapshot(context, subject.id)) ?? { root: subject, linked: [] };
  const graph = buildGraph(snapshot.root, snapshot.linked);
  const nodes = graph.nodes().map((id) => graph.getNodeAttributes(id) as ConversationNode);

  const kv = await getKvClient(logger ?? context.logger);
  if (!kv) {
    return { key: snapshot.root.id, root: snapshot.root, linked: snapshot.linked };
  }

  const candidateNodes: ConversationNode[] = [...nodes];
  const existingKeys = new Set<string>();

  for (const node of nodes) {
    const record = await getNodeRecord(kv, node.id);
    if (record) {
      const resolvedKey = await resolveAliasKey(kv, record.key);
      existingKeys.add(resolvedKey);
      candidateNodes.push({
        id: record.id,
        type: record.type,
        createdAt: record.createdAt,
        url: record.url,
        owner: record.owner,
        repo: record.repo,
        number: record.number,
        title: record.title,
      });
    }
  }

  for (const key of existingKeys) {
    const record = await getNodeRecord(kv, key);
    if (record) {
      candidateNodes.push({
        id: record.id,
        type: record.type,
        createdAt: record.createdAt,
        url: record.url,
        owner: record.owner,
        repo: record.repo,
        number: record.number,
        title: record.title,
      });
    }
  }

  const canonical = pickCanonicalNode(dedupeNodes(candidateNodes));
  const canonicalKey = canonical.id;

  if (!graph.hasNode(canonicalKey)) {
    graph.addNode(canonicalKey, canonical);
  }

  for (const key of existingKeys) {
    const resolvedKey = await resolveAliasKey(kv, key);
    if (resolvedKey !== canonicalKey) {
      await mergeKeys(kv, resolvedKey, canonicalKey);
    }
  }

  for (const node of nodes) {
    await persistNode(kv, node, canonicalKey);
  }

  await persistNode(kv, canonical, canonicalKey);

  return { key: canonicalKey, root: snapshot.root, linked: snapshot.linked };
}

export async function listConversationNodesForKey(context: GitHubContext, key: string, limit = 40, logger?: LoggerLike): Promise<ConversationNode[]> {
  const trimmedKey = normalizeString(key);
  if (!trimmedKey) return [];
  const kv = await getKvClient(logger ?? context.logger);
  if (!kv) return [];
  const nodeIds = await listNodesForKey(kv, trimmedKey);
  const uniqueIds = [...new Set(nodeIds)].slice(0, Math.max(0, limit));
  const nodes: ConversationNode[] = [];
  for (const nodeId of uniqueIds) {
    const record = await getNodeRecord(kv, nodeId);
    if (!record) continue;
    nodes.push({
      id: record.id,
      type: record.type,
      createdAt: record.createdAt,
      url: record.url,
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      title: record.title,
    });
  }
  return nodes;
}
