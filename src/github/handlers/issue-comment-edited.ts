import { GitHubContext } from "../github-context";
import { upsertAgentRunMemory } from "../utils/agent-memory";

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

export default async function issueCommentEdited(context: GitHubContext<"issue_comment.edited">) {
  const body = String(context.payload.comment?.body ?? "");
  const block = extractAgentBlock(body);
  if (!block) return;

  const parsed = parseAgentBlock(block);
  if (!parsed) return;

  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const issueNumber = context.payload.issue.number;

  await upsertAgentRunMemory({
    owner,
    repo,
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
  });
}
