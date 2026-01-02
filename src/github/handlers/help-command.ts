import { GitHubContext } from "../github-context";
import { GithubPlugin, parsePluginIdentifier } from "../types/plugin-configuration";
import { getConfig } from "../utils/config";
import { getManifest } from "../utils/plugins";
import { KERNEL_VERSION } from "../../version.ts";

// Deno won't necessarily be here, which is why we forward declare it
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  readTextFile(path: string): Promise<string>;
  Command: new (
    command: string,
    options: { args: string[]; stdout?: "piped"; stderr?: "piped" }
  ) => {
    output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  };
};

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
  const version = await getPackageVersion();
  const commitHash = await getCommitHash();
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

function getCommentNodeId(context: GitHubContext<"issue_comment.created">): string | null {
  const nodeId = context.payload.comment?.node_id;
  return typeof nodeId === "string" && nodeId.trim() ? nodeId : null;
}

function getGraphqlClient(context: GitHubContext<"issue_comment.created">) {
  const graphql = (context.octokit as { graphql?: (query: string, variables?: Record<string, unknown>) => Promise<unknown> }).graphql;
  return typeof graphql === "function" ? graphql : null;
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

  const commentNodeId = getCommentNodeId(context);
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
 * Get the kernel version
 */
async function getPackageVersion(): Promise<string> {
  const envVersion = getEnvValue("UOS_KERNEL_VERSION") ?? getEnvValue("npm_package_version") ?? getEnvValue("PACKAGE_VERSION");
  if (envVersion) {
    return envVersion.trim();
  }
  return KERNEL_VERSION;
}

/**
 * Get the current git commit hash
 */
async function getCommitHash(): Promise<string> {
  const envHash = toShortCommitHash(getEnvValue("GIT_REVISION") ?? getEnvValue("GITHUB_SHA"));
  if (envHash) {
    return envHash;
  }

  // Try git command first (works in deno server)
  try {
    const gitHash = await runGitCommand("rev-parse --short HEAD");
    if (gitHash) {
      return gitHash.trim();
    }
  } catch {
    // git command not available, fall back to file reading
  }

  // Fall back to reading git files (works in deno server with file access)
  for (const root of ROOT_SEARCH_PATHS) {
    const dotGitHead = await readTextFile(`${root}/.git/HEAD`);
    if (dotGitHead) {
      const revision = await readGitHeadShortRevision(`${root}/.git`);
      if (revision) {
        return revision;
      }
    }

    const dotGitFile = await readTextFile(`${root}/.git`);
    if (!dotGitFile) {
      continue;
    }
    const gitDir = parseGitDirFromDotGitFile(dotGitFile);
    if (!gitDir) {
      continue;
    }
    const resolvedGitDir = isAbsolutePath(gitDir) ? gitDir : `${root}/${gitDir}`;
    const revision = await readGitHeadShortRevision(resolvedGitDir);
    if (revision) {
      return revision;
    }
  }

  return "unknown";
}

/**
 * Ensures that passed content does not break MD display within the table.
 */
function getContent(content: string | undefined) {
  if (!content) return "-";
  return content.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

const ROOT_SEARCH_PATHS = [".", "..", "../..", "../../..", "../../../..", "../../../../..", "../../../../../..", "../../../../../../.."];

const COMMIT_HASH_LEN = 7;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const getEnvValue = (key: string): string | undefined => {
  if (typeof Deno !== "undefined") {
    try {
      const value = Deno.env.get(key);
      if (value) {
        return value;
      }
    } catch {
      // ignore env access errors
    }
  }
  if (typeof process !== "undefined" && process.env) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
};

const readTextFile = async (path: string): Promise<string | null> => {
  if (typeof Deno !== "undefined") {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return null;
    }
  }

  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
};

const toShortCommitHash = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || !COMMIT_HASH_RE.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_LEN);
};

const parseGitDirFromDotGitFile = (content: string): string | null => {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
  const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
  return match?.[1]?.trim() ?? null;
};

const isAbsolutePath = (path: string): boolean => path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);

const readGitHeadShortRevision = async (gitDir: string): Promise<string | null> => {
  const head = await readTextFile(`${gitDir}/HEAD`);
  if (!head) {
    return null;
  }
  const trimmedHead = head.trim();
  const refMatch = trimmedHead.match(/^ref:\s*(.+)\s*$/);
  if (!refMatch) {
    return toShortCommitHash(trimmedHead);
  }

  const refPath = refMatch[1]?.trim();
  if (!refPath) {
    return null;
  }

  const ref = await readTextFile(`${gitDir}/${refPath}`);
  if (ref) {
    return toShortCommitHash(ref.trim());
  }

  const packedRefs = await readTextFile(`${gitDir}/packed-refs`);
  if (!packedRefs) {
    return null;
  }

  for (const line of packedRefs.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) {
      continue;
    }
    const space = trimmed.indexOf(" ");
    if (space === -1) {
      continue;
    }
    const hash = trimmed.slice(0, space).trim();
    const refName = trimmed.slice(space + 1).trim();
    if (refName === refPath) {
      return toShortCommitHash(hash);
    }
  }

  return null;
};

const runGitCommand = async (args: string): Promise<string | null> => {
  try {
    if (typeof Deno !== "undefined") {
      const command = new Deno.Command("git", { args: args.split(" ") });
      const { code, stdout } = await command.output();
      if (code === 0) {
        return new TextDecoder().decode(stdout).trim();
      }
    } else {
      // Node.js fallback
      const { execSync } = await import("child_process");
      return execSync(`git ${args}`, { encoding: "utf8" }).trim();
    }
  } catch {
    return null;
  }
  return null;
};
