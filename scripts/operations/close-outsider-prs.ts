import { createAppAuth } from "@octokit/auth-app";

const DIGEST = "6b5f8a70d5b2a20402971e46662db2c9417f1163aadaa8c3c7ec62608569c384";
const BRANCH = "codex/2026-10-29-outsider-pr-cleanup-g7c74559729";
const INVENTORY_TIME = Date.parse("2026-10-29T05:19:04Z");
const MANIFEST = ".github/cleanup/outsider-prs-20261029.json";
const deadline = Date.now() + 10 * 60_000;
let requests = 0;
type Target = { repo: string; number: number; author: string; head: string };
type Pull = {
  state: string;
  merged: boolean;
  merged_at: string | null;
  updated_at: string;
  user: { login: string };
  head: { sha: string };
  assignees: unknown[];
};
type Review = { submitted_at: string | null };
type Access = { token: string; installationId: number };
class Stop extends Error {}
function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Stop(code);
}
function report(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...details }));
}
function mask(token: string) {
  console.log(`::add-mask::${token}`);
}
async function pause(ms: number) {
  requireCondition(ms <= 60_000 && Date.now() + ms < deadline, "runtime_budget_exceeded");
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (method !== "DELETE") {
      requireCondition(Date.now() < deadline && ++requests <= 750, "api_budget_exceeded");
    }
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "uos-reviewed-pr-cleanup",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Stop("network_request_failed");
    }
    if (response.ok) {
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    }
    const isLimited =
      response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
    if (method === "GET" && isLimited && attempt < 2) {
      const retry = response.headers.get("retry-after");
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      let seconds = 2 ** attempt;
      if (retry) seconds = Number(retry);
      else if (reset) seconds = Math.ceil(reset - Date.now() / 1000);
      await response.body?.cancel();
      requireCondition(Number.isFinite(seconds) && seconds >= 0 && seconds <= 60, "rate_limit_wait_exceeds_budget");
      report("READ_BACKOFF", { status: response.status, seconds });
      await pause(Math.max(1000, seconds * 1000));
      continue;
    }
    await response.body?.cancel();
    throw new Stop(`api_${method.toLowerCase()}_http_${response.status}`);
  }
  throw new Stop("read_retry_budget_exceeded");
}
async function inspect(target: Target, token: string): Promise<"open" | "closed"> {
  report("CHECK_TARGET", { repo: target.repo, number: target.number });
  const reviews = await api<Review[]>("GET", `/repos/${target.repo}/pulls/${target.number}/reviews?per_page=100`, token);
  const pull = await api<Pull>("GET", `/repos/${target.repo}/pulls/${target.number}`, token);
  requireCondition(pull.user.login === target.author && pull.head.sha === target.head, "target_identity_or_head_drift");
  requireCondition(!pull.merged && !pull.merged_at, "target_merged");
  if (pull.state === "closed") return "closed";
  requireCondition(pull.state === "open", "unexpected_target_state");
  requireCondition(Array.isArray(pull.assignees) && pull.assignees.length === 0, "target_assignment_drift");
  const updated = Date.parse(pull.updated_at);
  requireCondition(Number.isFinite(updated) && updated <= INVENTORY_TIME, "target_metadata_freshness_drift");
  requireCondition(reviews.length < 100, "review_pagination_requires_review");
  requireCondition(
    reviews.every(
      (review) => review.submitted_at === null || (Number.isFinite(Date.parse(review.submitted_at)) && Date.parse(review.submitted_at) <= INVENTORY_TIME)
    ),
    "target_review_drift"
  );
  return "open";
}
async function main() {
  requireCondition(
    Deno.env.get("GITHUB_ACTIONS") === "true" && Deno.env.get("GITHUB_EVENT_NAME") === "workflow_dispatch" && Deno.env.get("GITHUB_REF_NAME") === BRANCH,
    "runner_context_required"
  );
  requireCondition(Deno.args.length === 0 && Deno.env.get("UOS_MANIFEST_SHA") === DIGEST, "manifest_digest_input_mismatch");
  const dryRun = Deno.env.get("UOS_DRY_RUN") ?? "true";
  requireCondition(dryRun === "true" || dryRun === "false", "invalid_dry_run");
  const bytes = await Deno.readFile(MANIFEST);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  requireCondition(digest === DIGEST, "manifest_content_mismatch");
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
    appId: number;
    appSlug: string;
    targets: Target[];
  };
  requireCondition(
    manifest.appId === 975031 && manifest.appSlug === "ubiquity-os" && Array.isArray(manifest.targets) && manifest.targets.length === 76,
    "manifest_scope_mismatch"
  );
  const targets = manifest.targets;
  requireCondition(new Set(targets.map((target) => `${target.repo}#${target.number}`)).size === 76, "duplicate_target");
  requireCondition(
    targets.every(
      (target) =>
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repo) &&
        Number.isSafeInteger(target.number) &&
        target.number > 0 &&
        typeof target.author === "string" &&
        /^[0-9a-f]{40}$/.test(target.head)
    ),
    "invalid_target"
  );
  const appId = Deno.env.get("APP_ID");
  const privateKey = Deno.env.get("APP_PRIVATE_KEY");
  requireCondition(appId === "975031" && privateKey, "official_app_credentials_required");
  const auth = createAppAuth({ appId, privateKey });
  const app = await auth({ type: "app" });
  mask(app.token);
  const identity = await api<{ id: number; slug: string }>("GET", "/app", app.token);
  requireCondition(identity.id === 975031 && identity.slug === "ubiquity-os", "official_app_identity_mismatch");
  const access = new Map<string, Access>();
  let closed = 0;
  let skipped = 0;
  let revocationFailures = 0;
  try {
    for (const repo of new Set(targets.map((target) => target.repo))) {
      const installation = await api<{ id: number; app_id: number; account: { login: string } }>("GET", `/repos/${repo}/installation`, app.token);
      requireCondition(
        installation.app_id === 975031 && installation.account.login.toLowerCase() === repo.split("/")[0].toLowerCase(),
        "installation_identity_mismatch"
      );
      const minted = await api<{ token: string; permissions: Record<string, string> }>(
        "POST",
        `/app/installations/${installation.id}/access_tokens`,
        app.token,
        {
          repositories: [repo.split("/")[1]],
          permissions: { pull_requests: "write" },
        }
      );
      requireCondition(typeof minted.token === "string" && minted.token.length > 0, "installation_token_missing");
      mask(minted.token);
      access.set(repo, {
        token: minted.token,
        installationId: installation.id,
      });
      requireCondition(
        minted.permissions.pull_requests === "write" && Object.keys(minted.permissions).every((key) => key === "pull_requests" || key === "metadata"),
        "token_permission_mismatch"
      );
      const repositories = await api<{ total_count: number; repositories: { full_name: string }[] }>(
        "GET",
        "/installation/repositories?per_page=100",
        minted.token
      );
      requireCondition(
        repositories.total_count === 1 && repositories.repositories.length === 1 && repositories.repositories[0].full_name.toLowerCase() === repo.toLowerCase(),
        "token_repository_scope_mismatch"
      );
      report("OFFICIAL_ACCESS", {
        appId: identity.id,
        appSlug: identity.slug,
        repo,
        installationId: installation.id,
      });
    }
    for (const target of targets) {
      const entry = access.get(target.repo);
      requireCondition(entry, "target_access_missing");
      const state = await inspect(target, entry.token);
      report("PREFLIGHT", { ...target, state });
    }
    report("ALL_PREFLIGHT_PASSED", {
      targets: targets.length,
      digest,
      dryRun: dryRun === "true",
      commit: Deno.env.get("GITHUB_SHA"),
    });
    if (dryRun === "true") return;
    for (const target of targets) {
      await pause(1000);
      const entry = access.get(target.repo);
      requireCondition(entry, "target_access_missing");
      const token = entry.token;
      if ((await inspect(target, token)) === "closed") {
        skipped++;
        report("ALREADY_CLOSED", target);
        continue;
      }
      const result = await api<Pull>("PATCH", `/repos/${target.repo}/pulls/${target.number}`, token, { state: "closed" });
      requireCondition(result.state === "closed" && !result.merged && !result.merged_at, "closure_response_mismatch");
      closed++;
      report("CLOSED", target);
    }
    report("COMPLETE", { targets: targets.length, closed, skipped });
  } finally {
    for (const [repo, entry] of access) {
      try {
        await api("DELETE", "/installation/token", entry.token);
        report("TOKEN_REVOKED", { repo, installationId: entry.installationId });
      } catch {
        revocationFailures++;
        report("TOKEN_REVOCATION_FAILED", {
          repo,
          installationId: entry.installationId,
        });
      }
    }
    requireCondition(revocationFailures === 0, "token_revocation_failed");
  }
}
try {
  await main();
} catch (error) {
  report("ABORT", {
    code: error instanceof Stop ? error.message : "unexpected_failure",
  });
  Deno.exitCode = 1;
}
