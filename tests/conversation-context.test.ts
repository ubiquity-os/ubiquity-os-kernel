import { describe, expect, it, jest } from "@jest/globals";
import type { GitHubContext } from "../src/github/github-context";
import type { ConversationKeyResult, ConversationNode } from "../src/github/utils/conversation-graph";
import type { VectorDocument } from "../src/github/utils/vector-db";
import { logger } from "../src/logger/logger";

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

async function loadModules() {
  jest.resetModules();
  jest.doMock("../src/github/utils/conversation-graph", () => ({
    listConversationNodesForKey: jest.fn(),
  }));
  jest.doMock("../src/github/utils/vector-db", () => ({
    fetchVectorDocument: jest.fn(),
    fetchVectorDocuments: jest.fn(),
    fetchVectorDocumentsByParentId: jest.fn(),
    findSimilarComments: jest.fn(),
    findSimilarIssues: jest.fn(),
    getVectorDbConfig: jest.fn(),
  }));

  const conversationGraph = await import("../src/github/utils/conversation-graph");
  const vectorDb = await import("../src/github/utils/vector-db");
  const { buildConversationContext } = await import("../src/github/utils/conversation-context");
  return { buildConversationContext, conversationGraph, vectorDb };
}

describe("buildConversationContext", () => {
  it("merges explicit and semantic threads with scoring boosts", async () => {
    const { buildConversationContext, conversationGraph, vectorDb } = await loadModules();
    const listSpy = conversationGraph.listConversationNodesForKey as jest.MockedFunction<typeof conversationGraph.listConversationNodesForKey>;
    const getConfigSpy = vectorDb.getVectorDbConfig as jest.MockedFunction<typeof vectorDb.getVectorDbConfig>;
    const fetchDocSpy = vectorDb.fetchVectorDocument as jest.MockedFunction<typeof vectorDb.fetchVectorDocument>;
    const findSimilarSpy = vectorDb.findSimilarIssues as jest.MockedFunction<typeof vectorDb.findSimilarIssues>;
    const findSimilarCommentsSpy = vectorDb.findSimilarComments as jest.MockedFunction<typeof vectorDb.findSimilarComments>;
    const fetchDocsSpy = vectorDb.fetchVectorDocuments as jest.MockedFunction<typeof vectorDb.fetchVectorDocuments>;
    const fetchDocsByParentSpy = vectorDb.fetchVectorDocumentsByParentId as jest.MockedFunction<typeof vectorDb.fetchVectorDocumentsByParentId>;

    listSpy.mockResolvedValue([explicitNodeB]);
    getConfigSpy.mockReturnValue({ url: "https://example.supabase.co", key: "test-key" });

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

    fetchDocSpy.mockResolvedValue(rootDoc);
    findSimilarSpy.mockResolvedValue([
      { id: "similar-1", similarity: 0.9 },
      { id: "similar-2", similarity: 0.9 },
    ]);
    findSimilarCommentsSpy.mockResolvedValue([]);
    fetchDocsByParentSpy.mockResolvedValue([]);

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

    fetchDocsSpy.mockImplementation(async (config, ids) => {
      void config;
      return ids.map((id) => documents.get(id)).filter(Boolean) as VectorDocument[];
    });

    const result = await buildConversationContext({
      context: baseContext,
      conversation,
      maxItems: 5,
      maxChars: 4000,
    });

    expect(result).toContain("Conversation links (auto-merged):");
    expect(result).toContain(explicitNodeA.url);
    expect(result).toContain(explicitNodeB.url);
    expect(result).toContain("Related threads (semantic):");

    const firstIndex = result.indexOf("https://github.com/acme/repo/issues/4");
    const secondIndex = result.indexOf("https://github.com/other/other-repo/issues/5");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeLessThan(secondIndex);
  });

  it("skips semantic lookup when disabled", async () => {
    const { buildConversationContext, conversationGraph, vectorDb } = await loadModules();
    const listSpy = conversationGraph.listConversationNodesForKey as jest.MockedFunction<typeof conversationGraph.listConversationNodesForKey>;
    const getConfigSpy = vectorDb.getVectorDbConfig as jest.MockedFunction<typeof vectorDb.getVectorDbConfig>;

    listSpy.mockResolvedValue([]);
    getConfigSpy.mockReturnValue({ url: "https://example.supabase.co", key: "test-key" });

    const result = await buildConversationContext({
      context: baseContext,
      conversation,
      includeSemantic: false,
    });

    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(result).toContain("Conversation links (auto-merged):");
    expect(result).not.toContain("Related threads (semantic):");
  });
});
