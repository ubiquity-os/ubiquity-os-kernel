import { GitHubEventHandler } from "../github-event-handler";

function normalizeOwner(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if ("statusCode" in error && typeof (error as { statusCode?: unknown }).statusCode === "number") {
    return (error as { statusCode: number }).statusCode;
  }
  return null;
}

export function isPrivilegedAuthorAssociation(value: unknown): boolean {
  const assoc = typeof value === "string" ? value.trim().toUpperCase() : "";
  return assoc === "OWNER" || assoc === "MEMBER" || assoc === "COLLABORATOR";
}

async function getInstallationIdForOrg(eventHandler: GitHubEventHandler, org: string): Promise<number | null> {
  const octokit = eventHandler.getUnauthenticatedOctokit();
  const { data } = await octokit.request("GET /orgs/{org}/installation", { org });
  return readFiniteNumber((data as { id?: unknown })?.id);
}

async function getInstallationIdForUser(eventHandler: GitHubEventHandler, username: string): Promise<number | null> {
  const octokit = eventHandler.getUnauthenticatedOctokit();
  const { data } = await octokit.request("GET /users/{username}/installation", { username });
  return readFiniteNumber((data as { id?: unknown })?.id);
}

export async function tryGetInstallationTokenForOwner(eventHandler: GitHubEventHandler, owner: string): Promise<string | null> {
  const normalizedOwner = normalizeOwner(owner);
  if (!normalizedOwner) return null;

  let installationId: number | null = null;

  try {
    installationId = await getInstallationIdForOrg(eventHandler, normalizedOwner);
  } catch (error) {
    const status = readHttpStatus(error);
    if (status !== 404) throw error;
  }

  if (installationId === null) {
    try {
      installationId = await getInstallationIdForUser(eventHandler, normalizedOwner);
    } catch (error) {
      const status = readHttpStatus(error);
      if (status !== 404) throw error;
    }
  }

  if (installationId === null) return null;
  return await eventHandler.getToken(installationId);
}

