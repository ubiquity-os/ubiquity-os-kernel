import { GitHubContext } from "../github-context";
import { upsertAgentRunMemory } from "../utils/agent-memory";
import { resolveConversationKeyForContext } from "../utils/conversation-graph";

const botLoginCache = new Map<number, string>();

type ParsedAgentBlock = Readonly<{
  stateId: string;
  status: string;
  runUrl?: string;
  prUrl?: string;
  updatedAt: string;
  summary?: string;
}>;

function extractAgentBlock(body: string): string | null {
  const match = /<!--\s*ubiquityos-agent[\s\S]*?-->/u.exec(body);
  return match?.[0] ?? null;
}

function parseAgentBlock(block: string): ParsedAgentBlock | null {
  const cleaned = block
    .replace(/^<!--\s*ubiquityos-agent\s*/u, "")
    .replace(/-->\s*$/u, "")
    .trim();
  if (!cleaned) return null;

  const lines = cleaned.split(/\r?\n/u).map((l) => l.trimEnd());
  const summaryHeaderIndex = lines.findIndex((l) => l.trim() === "Agent summary:");

  const headerLines = summaryHeaderIndex >= 0 ? lines.slice(0, summaryHeaderIndex) : lines;
  const summaryLines = summaryHeaderIndex >= 0 ? lines.slice(summaryHeaderIndex + 1) : [];

  let runUrl = "";
  let status = "";
  let prUrl = "";
  let stateId = "";
  let updatedAt = "";

  for (const raw of headerLines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("Run logs:")) runUrl = line.slice("Run logs:".length).trim();
    else if (line.startsWith("Status:")) status = line.slice("Status:".length).trim();
    else if (line.startsWith("PR:")) prUrl = line.slice("PR:".length).trim();
    else if (line.startsWith("StateId:")) stateId = line.slice("StateId:".length).trim();
    else if (line.startsWith("Updated:")) updatedAt = line.slice("Updated:".length).trim();
  }

  if (!stateId || !status) return null;
  const normalizedUpdatedAt = updatedAt || new Date().toISOString();
  const summary = summaryLines.join("\n").trim();

  return {
    stateId,
    status,
    updatedAt: normalizedUpdatedAt,
    runUrl: runUrl || undefined,
    prUrl: prUrl || undefined,
    summary: summary || undefined,
  };
}

async function getInstallationBotLogin(context: GitHubContext<"issue_comment.edited">): Promise<string> {
  const installationId = context.payload.installation?.id;
  if (typeof installationId !== "number" || !Number.isFinite(installationId)) return "";
  const cached = botLoginCache.get(installationId);
  if (cached) return cached;

  try {
    const { data } = await context.octokit.rest.users.getAuthenticated();
    const login = typeof data?.login === "string" ? data.login.trim() : "";
    if (login) botLoginCache.set(installationId, login);
    return login;
  } catch (error) {
    context.logger.debug({ err: error }, "Failed to resolve bot login (non-fatal)");
    return "";
  }
}

export default async function issueCommentEdited(context: GitHubContext<"issue_comment.edited">) {
  const senderLogin = context.payload.sender?.login ?? "";
  const senderType = context.payload.sender?.type ?? "";
  if (senderType !== "Bot" || !senderLogin) return;

  const expectedBot = await getInstallationBotLogin(context);
  if (!expectedBot || senderLogin !== expectedBot) return;

  const body = String(context.payload.comment?.body ?? "");
  const block = extractAgentBlock(body);
  if (!block) return;

  const parsed = parseAgentBlock(block);
  if (!parsed) return;

  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const issueNumber = context.payload.issue.number;
  const conversation = await resolveConversationKeyForContext(context, context.logger);

  await upsertAgentRunMemory({
    owner,
    repo,
    scopeKey: conversation?.key,
    entry: {
      kind: "agent_run",
      stateId: parsed.stateId,
      status: parsed.status,
      issueNumber,
      updatedAt: parsed.updatedAt,
      runUrl: parsed.runUrl,
      prUrl: parsed.prUrl,
      summary: parsed.summary,
    },
    logger: context.logger,
  });
}
