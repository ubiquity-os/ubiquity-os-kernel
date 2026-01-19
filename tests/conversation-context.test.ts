import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

import type { GitHubContext } from "../src/github/github-context.ts";
import { buildConversationContext } from "../src/github/utils/conversation-context.ts";
import type { ConversationKeyResult, ConversationNode } from "../src/github/utils/conversation-graph.ts";
import type { VectorDocument } from "../src/github/utils/vector-db.ts";
import { logger } from "../src/logger/logger.ts";

const mockOctokit = {
  rest: {
    issues: {
      get: async () => ({ data: { body: "" } }),
      listComments: async () => ({ data: [] }),
    },
    pulls: {
      get: async () => ({ data: { body: "" } }),
      listReviewComments: async () => ({ data: [] }),
      listReviews: async () => ({ data: [] }),
    },
  },
};

const baseContext = {
  payload: {
    repository: {
      owner: { login: "acme" },
    },
    issue: {
      user: { id: 7 },
    },
    comment: {
      user: { id: 7 },
    },
  },
  octokit: mockOctokit,
  logger,
} as unknown as GitHubContext;

const rootNode: ConversationNode = {
  id: "root-node",
  type: "Issue",
  createdAt: "2025-01-01T00:00:00Z",
  url: "https://github.com/acme/repo/issues/1",
  owner: "acme",
  repo: "repo",
  number: 1,
  title: "Root issue",
};

const explicitNodeA: ConversationNode = {
  id: "explicit-a",
  type: "Issue",
  createdAt: "2025-01-02T00:00:00Z",
  url: "https://github.com/acme/repo/issues/2",
  owner: "acme",
  repo: "repo",
  number: 2,
  title: "Spec issue",
};

const explicitNodeB: ConversationNode = {
  id: "explicit-b",
  type: "PullRequest",
  createdAt: "2025-01-03T00:00:00Z",
  url: "https://github.com/acme/repo/pull/3",
  owner: "acme",
  repo: "repo",
  number: 3,
  title: "Implementation PR",
};

const conversation: ConversationKeyResult = {
  key: "conv-1",
  root: rootNode,
  linked: [explicitNodeA],
};

Deno.test("buildConversationContext: merges explicit and semantic threads", async () => {
  const listConversationNodesForKeyCalls: unknown[] = [];
  const getVectorDbConfigCalls: unknown[] = [];
  const fetchVectorDocumentCalls: unknown[] = [];
  const fetchVectorDocumentsCalls: unknown[] = [];

  const rootDoc: VectorDocument = {
    id: rootNode.id,
    docType: "issue",
    markdown: "Root body",
    embedding: [0.01, 0.02],
    authorId: 7,
    payload: {
      repository: { owner: { login: "acme" }, name: "repo" },
      issue: {
        number: 1,
        title: "Root issue",
        html_url: rootNode.url,
        created_at: rootNode.createdAt,
        updated_at: rootNode.createdAt,
      },
    },
  };

  const documents = new Map<string, VectorDocument>([
    [
      explicitNodeA.id,
      {
        id: explicitNodeA.id,
        docType: "issue",
        markdown: "Explicit A details",
        embedding: null,
        authorId: 7,
        payload: {
          repository: { owner: { login: "acme" }, name: "repo" },
          issue: {
            number: 2,
            title: "Spec issue",
            html_url: explicitNodeA.url,
            created_at: explicitNodeA.createdAt,
            updated_at: explicitNodeA.createdAt,
          },
        },
      },
    ],
    [
      explicitNodeB.id,
      {
        id: explicitNodeB.id,
        docType: "pull_request",
        markdown: "Explicit B details",
        embedding: null,
        authorId: 42,
        payload: {
          repository: { owner: { login: "acme" }, name: "repo" },
          pull_request: {
            number: 3,
            title: "Implementation PR",
            html_url: explicitNodeB.url,
            created_at: explicitNodeB.createdAt,
            updated_at: explicitNodeB.createdAt,
          },
        },
      },
    ],
    [
      "similar-1",
      {
        id: "similar-1",
        docType: "issue",
        markdown: "Similar issue A",
        embedding: null,
        authorId: 7,
        payload: {
          repository: { owner: { login: "acme" }, name: "repo" },
          issue: {
            number: 4,
            title: "Follow-up issue",
            html_url: "https://github.com/acme/repo/issues/4",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
          },
        },
      },
    ],
    [
      "similar-2",
      {
        id: "similar-2",
        docType: "issue",
        markdown: "Similar issue B",
        embedding: null,
        authorId: 99,
        payload: {
          repository: { owner: { login: "other" }, name: "other-repo" },
          issue: {
            number: 5,
            title: "Other issue",
            html_url: "https://github.com/other/other-repo/issues/5",
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-10T00:00:00Z",
          },
        },
      },
    ],
  ]);

  const result = await buildConversationContext({
    context: baseContext,
    conversation,
    maxItems: 5,
    maxChars: 4000,
    deps: {
      listConversationNodesForKey: async (...args) => {
        listConversationNodesForKeyCalls.push(args);
        return [explicitNodeB];
      },
      getVectorDbConfig: (...args) => {
        getVectorDbConfigCalls.push(args);
        return { url: "https://example.supabase.co", key: "test-key" } as never;
      },
      fetchVectorDocument: async (...args) => {
        fetchVectorDocumentCalls.push(args);
        return rootDoc;
      },
      findSimilarIssues: async () => [
        { id: "similar-1", similarity: 0.9 },
        { id: "similar-2", similarity: 0.9 },
      ],
      findSimilarComments: async () => [],
      fetchVectorDocumentsByParentId: async () => [],
      fetchVectorDocuments: async (_config, ids) => {
        fetchVectorDocumentsCalls.push(ids);
        return ids.map((id) => documents.get(id)).filter(Boolean) as VectorDocument[];
      },
    },
  });

  assertStringIncludes(result, "Current thread:");
  assertStringIncludes(result, "Conversation links (auto-merged):");
  assertStringIncludes(result, rootNode.url);
  assertStringIncludes(result, explicitNodeA.url);
  assertStringIncludes(result, explicitNodeB.url);
  assertStringIncludes(result, "Similar (semantic):");

  const firstIndex = result.indexOf("https://github.com/acme/repo/issues/4");
  const secondIndex = result.indexOf("https://github.com/other/other-repo/issues/5");
  assert(firstIndex > -1);
  assert(secondIndex > -1);
  assert(firstIndex < secondIndex);

  assertEquals(getVectorDbConfigCalls.length, 1);
  assertEquals(fetchVectorDocumentCalls.length, 1);
  assertEquals(listConversationNodesForKeyCalls.length, 1);
  assert(fetchVectorDocumentsCalls.length > 0);
});

Deno.test("buildConversationContext: skips semantic lookup when disabled", async () => {
  const getVectorDbConfigCalls: unknown[] = [];

  const result = await buildConversationContext({
    context: baseContext,
    conversation,
    includeSemantic: false,
    deps: {
      listConversationNodesForKey: async () => [],
      getVectorDbConfig: (...args) => {
        getVectorDbConfigCalls.push(args);
        return { url: "https://example.supabase.co", key: "test-key" } as never;
      },
    },
  });

  assertEquals(getVectorDbConfigCalls.length, 0);
  assertStringIncludes(result, "Conversation links (auto-merged):");
});
