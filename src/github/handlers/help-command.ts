import { GitHubContext } from "../github-context";
import { GithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { getKernelCommit, getKernelVersion } from "../utils/kernel-metadata";

type CommandRow = {
  key: string;
  row: string;
};

const COMMAND_RESPONSE_MARKER = '"commentKind": "command-response"';
const COMMAND_RESPONSE_COMMENT_LIMIT = 50;
const RECENT_COMMENTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $last: Int!) {
    repository(owner: $owner, name: $repo) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue {
          comments(last: $last) {
            nodes {
              id
              body
              isMinimized
              minimizedReason
            }
          }
        }
        ... on PullRequest {
          comments(last: $last) {
            nodes {
              id
              body
              isMinimized
              minimizedReason
            }
          }
        }
      }
    }
  }
`;
const MINIMIZE_COMMENT_MUTATION = `
  mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
    minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
      minimizedComment {
        isMinimized
        minimizedReason
      }
    }
  }
`;

type GraphqlCommentNode = {
  id: string;
  body?: string | null;
  isMinimized?: boolean | null;
  minimizedReason?: string | null;
};

type GraphqlIssueCommentsResponse = {
  repository?: {
    issueOrPullRequest?: {
      comments?: { nodes?: Array<GraphqlCommentNode | null> | null } | null;
    } | null;
  } | null;
};

type GraphqlRequest = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

async function parseCommandsFromManifest(context: GitHubContext<"issue_comment.created">, plugin: string | GithubPlugin) {
  const commands: CommandRow[] = [];
  const manifest = await getManifest(context, plugin);
  if (manifest?.commands) {
    for (const [rawName, command] of Object.entries(manifest.commands)) {
      const name = rawName.trim();
      const key = name.toLowerCase();
      commands.push({
        key,
        row: `| \`/${getContent(name)}\` | ${getContent(command.description)} | \`${getContent(command["ubiquity:example"])}\` |`,
      });
    }
  }
  return commands;
}

export async function postHelpCommand(context: GitHubContext<"issue_comment.created">) {
  await applyCommandResponsePolicy(context);

  // Get kernel version and commit hash
  const version = await getKernelVersion();
  const commitHash = await getKernelCommit();
  const environment = context.eventHandler.environment;

  const comments = ["| Command | Description | Example |", "|---|---|---|"];
  const commandRows = new Map<string, string>();
  const configuration = await getConfig(context);
  for (const [pluginKey] of Object.entries(configuration.plugins)) {
    let plugin: string | GithubPlugin;
    try {
      plugin = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }
    for (const command of await parseCommandsFromManifest(context, plugin)) {
      commandRows.set(command.key, command.row);
    }
  }
  if (!commandRows.size) {
    context.logger.warn("No commands found, will not post the help command message.");
  } else {
    if (!commandRows.has("help")) {
      commandRows.set("help", "| `/help` | List all available commands. | `/help` |");
    }
    const commands = [...commandRows.entries()]
      .sort(([a], [b]) => {
        if (a === "help") return -1;
        if (b === "help") return 1;
        return a.localeCompare(b);
      })
      .map(([, row]) => row);
    const footer = `\n\n###### UbiquityOS ${environment.charAt(0).toUpperCase() + environment.slice(1).toLowerCase()} [v${version}](https://github.com/ubiquity-os/ubiquity-os-kernel/releases/tag/v${version}) [${commitHash}](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/${commitHash})`;
    const body = appendCommandResponseMarker(comments.concat(commands).join("\n") + footer);
    await context.octokit.rest.issues.createComment({
      body,
      issue_number: context.payload.issue.number,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    });
  }
}

function appendCommandResponseMarker(body: string): string {
  if (body.includes(COMMAND_RESPONSE_MARKER)) return body;
  return `${body}\n\n<!-- ${COMMAND_RESPONSE_MARKER} -->`;
}

function hasCommandResponseMarker(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(COMMAND_RESPONSE_MARKER);
}

function getIssueLocator(context: GitHubContext<"issue_comment.created">): { owner: string; repo: string; issueNumber: number } | null {
  const owner = context.payload.repository?.owner?.login;
  const repo = context.payload.repository?.name;
  const issueNumber = context.payload.issue?.number;
  if (!owner || !repo || !issueNumber) return null;
  return { owner, repo, issueNumber };
}

async function getCommentNodeId(context: GitHubContext<"issue_comment.created">): Promise<string | null> {
  const nodeId = context.payload.comment?.node_id;
  if (typeof nodeId === "string" && nodeId.trim()) {
    return nodeId;
  }

  const commentId = context.payload.comment?.id;
  const locator = getIssueLocator(context);
  if (!commentId || !locator) {
    return null;
  }

  try {
    const { data } = await context.octokit.rest.issues.getComment({
      owner: locator.owner,
      repo: locator.repo,
      comment_id: commentId,
    });
    const fetchedNodeId = (data as { node_id?: string | null }).node_id;
    return typeof fetchedNodeId === "string" && fetchedNodeId.trim() ? fetchedNodeId : null;
  } catch (error) {
    context.logger.debug("Failed to fetch comment node id (non-fatal)", { err: error, commentId });
    return null;
  }
}

function getGraphqlClient(context: GitHubContext<"issue_comment.created">): GraphqlRequest | null {
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

async function fetchRecentComments(
  context: GitHubContext<"issue_comment.created">,
  locator: { owner: string; repo: string; issueNumber: number },
  last = COMMAND_RESPONSE_COMMENT_LIMIT
): Promise<GraphqlCommentNode[]> {
  const graphql = getGraphqlClient(context);
  if (!graphql) return [];
  try {
    const data = (await graphql(RECENT_COMMENTS_QUERY, {
      owner: locator.owner,
      repo: locator.repo,
      number: locator.issueNumber,
      last,
    })) as GraphqlIssueCommentsResponse;
    const nodes = data.repository?.issueOrPullRequest?.comments?.nodes ?? [];
    return nodes.filter((node): node is GraphqlCommentNode => Boolean(node));
  } catch (error) {
    context.logger.debug("Failed to fetch recent comments (non-fatal)", { err: error });
    return [];
  }
}

function findPreviousCommandResponseComment(comments: GraphqlCommentNode[], currentCommentId: string | null): GraphqlCommentNode | null {
  for (let idx = comments.length - 1; idx >= 0; idx -= 1) {
    const comment = comments[idx];
    if (!comment) continue;
    if (currentCommentId && comment.id === currentCommentId) continue;
    if (hasCommandResponseMarker(comment.body)) {
      return comment;
    }
  }
  return null;
}

async function minimizeComment(
  context: GitHubContext<"issue_comment.created">,
  commentNodeId: string,
  classifier: "RESOLVED" | "OUTDATED" = "RESOLVED"
): Promise<void> {
  const graphql = getGraphqlClient(context);
  if (!graphql) return;
  try {
    await graphql(MINIMIZE_COMMENT_MUTATION, {
      id: commentNodeId,
      classifier,
    });
  } catch (error) {
    context.logger.debug("Failed to minimize comment (non-fatal)", { err: error, commentNodeId });
  }
}

async function applyCommandResponsePolicy(context: GitHubContext<"issue_comment.created">): Promise<void> {
  const graphql = getGraphqlClient(context);
  if (!graphql) return;
  const locator = getIssueLocator(context);
  if (!locator) return;

  const commentNodeId = await getCommentNodeId(context);
  const comments = await fetchRecentComments(context, locator);
  const current = commentNodeId ? comments.find((comment) => comment.id === commentNodeId) : null;
  const isCurrentMinimized = current?.isMinimized ?? false;

  if (commentNodeId && !isCurrentMinimized) {
    await minimizeComment(context, commentNodeId);
  }

  const previous = findPreviousCommandResponseComment(comments, commentNodeId);
  if (previous && !previous.isMinimized) {
    await minimizeComment(context, previous.id);
  }
}

/**
 * Ensures that passed content does not break MD display within the table.
 */
function getContent(content: string | undefined) {
  if (!content) return "-";
  return content.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
