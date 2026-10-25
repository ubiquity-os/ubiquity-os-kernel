import { assertEquals } from "jsr:@std/assert";
import {
  extractRepositoryFullName,
  getRepositoryConfigStatus,
  isRepositoryKnownUnconfigured,
  markRepositoryConfigured,
  markRepositoryUnconfigured,
  pushTouchesKernelConfig,
  resetRepositoryConfigCache,
  shouldSkipUnconfiguredRepository,
} from "../src/github/utils/repository-config-cache.ts";
import { getConfig } from "../src/github/utils/config.ts";

const REPO = "tadanobutubutu/screeps";
const ENVIRONMENT = "production";

Deno.test("repository config cache: normalizes repository names", () => {
  assertEquals(extractRepositoryFullName({ repository: { full_name: " Owner/Repo " } }), "owner/repo");
  assertEquals(
    extractRepositoryFullName({
      repository: { owner: { login: "Owner" }, name: "Repo" },
    }),
    "owner/repo"
  );
  assertEquals(extractRepositoryFullName({}), null);
});

Deno.test("repository config cache: negative entries expire and are environment scoped", () => {
  resetRepositoryConfigCache();
  markRepositoryUnconfigured(ENVIRONMENT, REPO, 1_000);
  assertEquals(isRepositoryKnownUnconfigured(ENVIRONMENT, REPO, 2_000), true);
  assertEquals(isRepositoryKnownUnconfigured("development", REPO, 2_000), false);
  assertEquals(isRepositoryKnownUnconfigured(ENVIRONMENT, REPO, 1_000 + 5 * 60_000 + 1), false);
  resetRepositoryConfigCache();
});

Deno.test("repository config cache: configured repositories clear the negative entry", () => {
  resetRepositoryConfigCache();
  markRepositoryUnconfigured(ENVIRONMENT, REPO);
  markRepositoryConfigured(ENVIRONMENT, REPO);
  assertEquals(isRepositoryKnownUnconfigured(ENVIRONMENT, REPO), false);
  assertEquals(getRepositoryConfigStatus(ENVIRONMENT, REPO), "present");
  markRepositoryUnconfigured(ENVIRONMENT, REPO);
  assertEquals(getRepositoryConfigStatus(ENVIRONMENT, REPO), "absent");
  resetRepositoryConfigCache();
});

Deno.test("repository config cache: config-touching push bypasses negative cache", () => {
  resetRepositoryConfigCache();
  markRepositoryUnconfigured(ENVIRONMENT, REPO);
  const payload = {
    repository: { full_name: REPO },
    commits: [{ modified: [".github/.ubiquity-os.config.yml"] }],
  };
  assertEquals(pushTouchesKernelConfig(payload), true);
  assertEquals(shouldSkipUnconfiguredRepository(ENVIRONMENT, "push", payload), false);
  assertEquals(isRepositoryKnownUnconfigured(ENVIRONMENT, REPO), false);
  resetRepositoryConfigCache();
});

Deno.test("repository config cache: getConfig marks a repo with no configuration", async () => {
  resetRepositoryConfigCache();
  function notFound(): never {
    const error = new Error("Not Found") as Error & { status: number };
    error.status = 404;
    throw error;
  }
  const context = {
    payload: {
      repository: {
        owner: { login: "tadanobutubutu" },
        name: "screeps",
        full_name: REPO,
      },
    },
    octokit: { rest: { repos: { getContent: notFound } } },
    eventHandler: { environment: ENVIRONMENT },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as never;

  await getConfig(context);
  assertEquals(isRepositoryKnownUnconfigured(ENVIRONMENT, REPO), true);
  resetRepositoryConfigCache();
});
