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

function configurationContext(environment: string, lookup: (repo: string, path: string) => string) {
  return {
    payload: { repository: { owner: { login: "tadanobutubutu" }, name: "screeps", full_name: REPO } },
    octokit: { rest: { repos: { getContent: ({ repo, path }: { repo: string; path: string }) => ({ data: lookup(repo, path), headers: {} }) } } },
    eventHandler: { environment },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as never;
}

function githubFailure(status?: number): never {
  throw Object.assign(new Error("GitHub lookup failed"), status === undefined ? {} : { status });
}

Deno.test("repository config cache: non-404 and mixed-scope failures never establish absence", async () => {
  for (const status of [403, 429, 503, undefined]) {
    for (const failureScope of ["both", ".ubiquity-os", "screeps"]) {
      resetRepositoryConfigCache();
      await getConfig(configurationContext(ENVIRONMENT, (repo) => githubFailure(failureScope === "both" || repo === failureScope ? status : 404)));
      assertEquals(getRepositoryConfigStatus(ENVIRONMENT, REPO), null);
    }
  }
  resetRepositoryConfigCache();
});

Deno.test("repository config cache: existing empty and invalid files are never absent", async () => {
  for (const contents of ["", "[", "plugins: {}"]) {
    resetRepositoryConfigCache();
    await getConfig(configurationContext(ENVIRONMENT, () => contents));
    assertEquals(isRepositoryKnownUnconfigured(ENVIRONMENT, REPO), false);
  }
  resetRepositoryConfigCache();
});

Deno.test("repository config cache: development confirms all fallback paths before absence", async () => {
  resetRepositoryConfigCache();
  const paths: string[] = [];
  await getConfig(
    configurationContext("development", (repo, path) => {
      paths.push(`${repo}:${path}`);
      return githubFailure(404);
    })
  );
  assertEquals(getRepositoryConfigStatus("development", REPO), "absent");
  for (const repo of [".ubiquity-os", "screeps"]) {
    for (const path of [".github/.ubiquity-os.config.dev.yml", ".github/.ubiquity-os.config.yml"]) {
      assertEquals(paths.filter((value) => value === `${repo}:${path}`).length, path.endsWith(".dev.yml") ? 2 : 1);
    }
  }
  resetRepositoryConfigCache();
  await getConfig(configurationContext("development", (repo, path) => (path.endsWith(".dev.yml") ? githubFailure(404) : "plugins: {}")));
  assertEquals(isRepositoryKnownUnconfigured("development", REPO), false);
  resetRepositoryConfigCache();
});

Deno.test("repository config cache: development transient primary and missing fallback remain unknown", async () => {
  resetRepositoryConfigCache();
  await getConfig(configurationContext("development", (repo, path) => githubFailure(path.endsWith(".dev.yml") ? 503 : 404)));
  assertEquals(getRepositoryConfigStatus("development", REPO), null);
  resetRepositoryConfigCache();
});
