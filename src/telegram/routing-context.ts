import { CONFIG_ORG_REPO } from "../github/utils/config.ts";
import { normalizeGithubRepoName, normalizeLogin, normalizeOptionalString, parseOptionalPositiveInt } from "./normalization.ts";

export type TelegramRoutingConfig = {
  owner?: string;
  repo?: string;
  issueNumber?: number;
  installationId?: number;
};

export type TelegramContextKind = "issue" | "repo" | "org";

export type TelegramRoutingOverride = {
  kind: TelegramContextKind;
  owner: string;
  repo: string;
  issueNumber?: number;
  installationId?: number;
  sourceUrl?: string;
};

type ParsedGithubContext = {
  kind: TelegramContextKind;
  owner: string;
  repo?: string;
  issueNumber?: number;
  url: string;
};

export function parseGithubContextFromText(value: string): ParsedGithubContext | null {
  const candidates = value
    .split(/\s+/)
    .map((candidate) => candidate.trim().replace(/^[<(]+|[>),.]+$/g, ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    const parsed = tryParseGithubContextUrl(candidate) ?? tryParseGithubContextUrl(`https://${candidate}`) ?? tryParseGithubContextShorthand(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseGithubContextUrl(value: string): ParsedGithubContext | null {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 1) {
      const owner = parts[0];
      return { kind: "org", owner, url: buildOrgUrl(owner) };
    }
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      if (parts.length >= 4) {
        const segment = (parts[2] ?? "").toLowerCase();
        if (segment === "issues" || segment === "pull" || segment === "pulls") {
          const issueNumber = Number(parts[3]);
          if (Number.isFinite(issueNumber) && issueNumber > 0) {
            const normalizedIssueNumber = Math.trunc(issueNumber);
            return {
              kind: "issue",
              owner,
              repo,
              issueNumber: normalizedIssueNumber,
              url: buildIssueUrl({
                owner,
                repo,
                issueNumber: normalizedIssueNumber,
              }),
            };
          }
        }
      }
      return { kind: "repo", owner, repo, url: buildRepoUrl(owner, repo) };
    }
    return null;
  } catch {
    return null;
  }
}

function tryParseGithubContextShorthand(value: string): ParsedGithubContext | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const issueRefMatch = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)#(\d+)$/.exec(trimmed);
  if (issueRefMatch) {
    const owner = normalizeLogin(issueRefMatch[1]);
    const repo = normalizeGithubRepoName(issueRefMatch[2]);
    const issueNumber = parseOptionalPositiveInt(issueRefMatch[3]);
    if (owner && repo && issueNumber) {
      return {
        kind: "issue",
        owner,
        repo,
        issueNumber,
        url: buildIssueUrl({ owner, repo, issueNumber }),
      };
    }
  }

  const issuePathMatch = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)\/(?:issues|pull|pulls)\/(\d+)$/i.exec(trimmed);
  if (issuePathMatch) {
    const owner = normalizeLogin(issuePathMatch[1]);
    const repo = normalizeGithubRepoName(issuePathMatch[2]);
    const issueNumber = parseOptionalPositiveInt(issuePathMatch[3]);
    if (owner && repo && issueNumber) {
      return {
        kind: "issue",
        owner,
        repo,
        issueNumber,
        url: buildIssueUrl({ owner, repo, issueNumber }),
      };
    }
  }

  const repoMatch = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)$/.exec(trimmed);
  if (!repoMatch) return null;
  const owner = normalizeLogin(repoMatch[1]);
  const repo = normalizeGithubRepoName(repoMatch[2]);
  if (!owner || !repo) return null;
  return { kind: "repo", owner, repo, url: buildRepoUrl(owner, repo) };
}

export function buildIssueUrl(params: { owner: string; repo: string; issueNumber: number }): string {
  return `https://github.com/${params.owner}/${params.repo}/issues/${params.issueNumber}`;
}

export function buildRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

export function buildOrgUrl(owner: string): string {
  return `https://github.com/${owner}`;
}

export function buildTelegramRoutingOverride(context: ParsedGithubContext): TelegramRoutingOverride {
  if (context.kind === "org") {
    return {
      kind: "org",
      owner: context.owner,
      repo: CONFIG_ORG_REPO,
      sourceUrl: context.url,
    };
  }
  if (context.kind === "repo") {
    if (!context.repo) {
      throw new Error("Missing repo for Telegram repo context");
    }
    return {
      kind: "repo",
      owner: context.owner,
      repo: context.repo,
      sourceUrl: context.url,
    };
  }
  if (!context.repo || !context.issueNumber) {
    throw new Error("Missing issue context details");
  }
  return {
    kind: "issue",
    owner: context.owner,
    repo: context.repo,
    issueNumber: context.issueNumber,
    sourceUrl: context.url,
  };
}

export function describeTelegramContext(override: TelegramRoutingOverride): string {
  if (override.kind === "issue" && override.issueNumber) {
    return `Context set to ${override.owner}/${override.repo}#${override.issueNumber}.`;
  }
  if (override.kind === "org") {
    return `Context set to org ${override.owner} (config: ${override.owner}/${CONFIG_ORG_REPO}). Send a message to start a session, or use /topic <issue-url> to pin to a specific issue.`;
  }
  return `Context set to ${override.owner}/${override.repo}. Send a message to start a session, or use /topic <issue-url> to pin to a specific issue.`;
}

export function describeTelegramContextLabel(override: TelegramRoutingOverride): string {
  if (override.kind === "issue" && override.issueNumber) {
    return `${override.owner}/${override.repo}#${override.issueNumber}`;
  }
  if (override.kind === "org") {
    return `org ${override.owner}`;
  }
  return `${override.owner}/${override.repo}`;
}

export function formatRoutingLabel(routing: TelegramRoutingConfig): string | null {
  const owner = routing.owner?.trim() ?? "";
  const repo = routing.repo?.trim() ?? "";
  const issueNumber = routing.issueNumber;
  if (!owner) return null;
  if (repo && Number.isFinite(issueNumber) && Number(issueNumber) > 0) {
    return `${owner}/${repo}#${Number(issueNumber)}`;
  }
  if (repo) {
    return `${owner}/${repo}`;
  }
  return owner;
}

export function isSameTelegramRoutingOverride(a: TelegramRoutingOverride, b: TelegramRoutingOverride): boolean {
  const ownerA = normalizeLogin(a.owner);
  const ownerB = normalizeLogin(b.owner);
  if (!ownerA || !ownerB || ownerA !== ownerB) return false;

  const repoA = normalizeTelegramRepoName(a.repo);
  const repoB = normalizeTelegramRepoName(b.repo);
  if (!repoA || !repoB || repoA !== repoB) return false;

  const issueA = parseOptionalPositiveInt(a.issueNumber);
  const issueB = parseOptionalPositiveInt(b.issueNumber);
  if (issueA || issueB) {
    return issueA === issueB;
  }
  return a.kind === b.kind;
}

function normalizeTelegramRepoName(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

export function parseTelegramRoutingOverride(value: unknown): TelegramRoutingOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kindRaw = normalizeOptionalString(record.kind);
  const owner = normalizeOptionalString(record.owner);
  const repo = normalizeOptionalString(record.repo);
  const issueNumber = parseOptionalPositiveInt(record.issueNumber);
  let kind: TelegramContextKind;
  if (kindRaw === "org" || kindRaw === "repo" || kindRaw === "issue") {
    kind = kindRaw as TelegramContextKind;
  } else if (issueNumber) {
    kind = "issue";
  } else {
    kind = "repo";
  }
  const resolvedRepo = repo ?? (kind === "org" ? CONFIG_ORG_REPO : undefined);
  if (!owner || !resolvedRepo) return null;
  if (kind === "issue" && !issueNumber) return null;
  const installationId = parseOptionalPositiveInt(record.installationId);
  const sourceUrl = normalizeOptionalString(record.sourceUrl);
  return {
    kind,
    owner,
    repo: resolvedRepo,
    ...(issueNumber ? { issueNumber } : {}),
    ...(installationId ? { installationId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}
