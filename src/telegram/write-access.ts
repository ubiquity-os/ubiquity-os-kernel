import { GitHubContext } from "../github/github-context.ts";
import type { TelegramLinkedIdentity } from "./identity-store.ts";
import { normalizeLogin } from "./normalization.ts";

const TELEGRAM_WRITE_ACCESS_PERMISSIONS = new Set(["admin", "maintain", "write", "push"]);

type AccessLogger = {
  debug: (obj: unknown, msg?: string) => void;
};

export async function ensureTelegramActorWriteAccess(params: {
  context: GitHubContext<"issue_comment.created">;
  actorIdentity: TelegramLinkedIdentity | null;
  logger: AccessLogger;
}): Promise<{ ok: true; githubLogin: string } | { ok: false; error: string }> {
  const owner = params.context.payload.repository?.owner?.login?.trim() ?? "";
  const repo = params.context.payload.repository?.name?.trim() ?? "";
  if (!owner || !repo) {
    return {
      ok: false,
      error: "Missing repository context for access verification.",
    };
  }

  const linkedGithubLogin = normalizeLogin(params.actorIdentity?.githubLogin ?? "");
  if (!linkedGithubLogin) {
    return {
      ok: false,
      error: `I can't verify your write access for ${owner}/${repo} because your linked GitHub login is missing. Re-link in DM with /_status and try again.`,
    };
  }

  try {
    const { data } = await params.context.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: linkedGithubLogin,
    });
    const permission = typeof data?.permission === "string" ? data.permission.toLowerCase() : "";
    if (TELEGRAM_WRITE_ACCESS_PERMISSIONS.has(permission)) {
      return { ok: true, githubLogin: linkedGithubLogin };
    }
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
    params.logger.debug({ err: error, status, owner, repo, githubLogin: linkedGithubLogin }, "Failed to verify Telegram actor write access (non-fatal)");
  }

  return {
    ok: false,
    error: `Linked GitHub user ${linkedGithubLogin} does not have write access to ${owner}/${repo}.`,
  };
}
