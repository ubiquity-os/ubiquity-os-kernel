#!/usr/bin/env bun

// CLI to test kernel comment processing with real plugin execution
// This allows debugging and developing plugins with actual command execution

import { compressString } from "@ubiquity-os/plugin-sdk/compression";
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import YAML from "js-yaml";
import { getConfigPathCandidatesForEnvironment } from "../src/github/utils/config";

loadEnv({ path: ".dev.vars" });

interface PluginManifest {
  name: string;
  commands?: Record<
    string,
    {
      description: string;
      parameters?: unknown;
      strict?: boolean;
    }
  >;
}

interface PluginConfiguration {
  plugins: Record<string, unknown>;
}

type OctokitGetContentParams = {
  owner: string;
  repo: string;
  path: string;
  mediaType?: { format?: string };
};

type OctokitGetContentResponse = {
  data: unknown;
};

type MinimalOctokit = {
  rest: {
    repos: {
      getContent: (params: OctokitGetContentParams) => Promise<OctokitGetContentResponse>;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const status = error.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

async function downloadGitHubFileRaw(octokit: MinimalOctokit, { owner, repo, path }: { owner: string; repo: string; path: string }): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      mediaType: { format: "raw" },
    });
    return typeof data === "string" ? data : String(data);
  } catch (error: unknown) {
    if (getErrorStatus(error) === 404) return null;
    throw error;
  }
}

function normalizePluginConfiguration(raw: unknown): PluginConfiguration | null {
  if (!isRecord(raw)) return null;
  const config = raw;

  const pluginsRaw = config.plugins;
  if (!pluginsRaw) return { plugins: {} };

  if (Array.isArray(pluginsRaw)) {
    const convertedPlugins: Record<string, unknown> = {};
    for (const pluginItem of pluginsRaw) {
      if (!isRecord(pluginItem)) continue;
      const uses = pluginItem.uses;
      if (!Array.isArray(uses)) continue;
      for (const use of uses) {
        if (!isRecord(use)) continue;
        const pluginKey = use.plugin;
        if (typeof pluginKey !== "string" || !pluginKey.trim()) continue;
        const { plugin: _plugin, ...pluginConfig } = use;
        convertedPlugins[pluginKey] = pluginConfig;
      }
    }
    return { ...config, plugins: convertedPlugins };
  }

  if (!isRecord(pluginsRaw)) return { plugins: {} };
  return { ...config, plugins: pluginsRaw };
}

async function fetchFirstExistingRepoConfig(octokit: MinimalOctokit, { owner, repo }: { owner: string; repo: string }): Promise<PluginConfiguration | null> {
  const candidates = getConfigPathCandidatesForEnvironment(process.env.ENVIRONMENT ?? "development");
  for (const path of candidates) {
    const raw = await downloadGitHubFileRaw(octokit, { owner, repo, path });
    if (!raw) continue;
    const parsed = YAML.load(raw);
    const normalized = normalizePluginConfiguration(parsed);
    if (normalized) return normalized;
  }
  return null;
}

function mergeConfigurations(configuration1: PluginConfiguration, configuration2: PluginConfiguration): PluginConfiguration {
  return {
    ...configuration1,
    ...configuration2,
    plugins: {
      ...configuration1.plugins,
      ...configuration2.plugins,
    },
  };
}

// Cache configuration
const CACHE_DIR = ".test-cache";

function getEnvironmentCacheKey(): string {
  const raw = String(process.env.ENVIRONMENT ?? "development")
    .trim()
    .toLowerCase();
  let normalized: string;
  if (raw === "development") {
    normalized = "dev";
  } else if (raw === "prod") {
    normalized = "production";
  } else if (raw) {
    normalized = raw;
  } else {
    normalized = "dev";
  }
  return normalized.replace(/[^a-z0-9_-]/gi, "_");
}

function getConfigCachePath(org: string, repo: string): string {
  return join(CACHE_DIR, `config.${org}.${repo}.${getEnvironmentCacheKey()}.yml`);
}

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// Load cached config
function loadCachedConfig(configPath: string): PluginConfiguration | null {
  try {
    if (existsSync(configPath)) {
      const data = readFileSync(configPath, "utf8");
      return YAML.load(data) as PluginConfiguration;
    }
  } catch (error) {
    console.log(`⚠️  Failed to load cached config: ${error}`);
  }
  return null;
}

// Save config to cache
function saveConfigToCache(configPath: string, config: PluginConfiguration): void {
  try {
    const yamlData = YAML.dump(config);
    writeFileSync(configPath, yamlData, "utf8");
    console.log(`💾 Config cached to ${configPath}`);
  } catch (error) {
    console.log(`❌ Failed to save config to cache: ${error}`);
  }
}

// Fetch latest config from GitHub using kernel's config loading logic
async function fetchLatestConfig(org: string, repo: string): Promise<PluginConfiguration | null> {
  // Import and use the kernel's config loading logic
  const { getConfig } = await import("../src/github/utils/config.js");
  const { GitHubEventHandler } = await import("../src/github/github-event-handler.js");

  try {
    console.log(`📡 Fetching config using kernel logic...`);

    // Check for GitHub App credentials
    const appId = process.env.APP_ID;
    const privateKey = process.env.APP_PRIVATE_KEY;

    if (!appId || !privateKey) {
      const githubToken = (process.env.GITHUB_TOKEN ?? "").trim();
      if (!githubToken) {
        console.log("❌ No GitHub auth available. Set APP_ID+APP_PRIVATE_KEY or GITHUB_TOKEN.");
        return null;
      }

      console.log("🔑 Using GITHUB_TOKEN to download config...");
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: githubToken });

      const orgConfig = await fetchFirstExistingRepoConfig(octokit, { owner: org, repo: ".ubiquity-os" });
      const repoConfig = await fetchFirstExistingRepoConfig(octokit, { owner: org, repo });

      const defaultConfig: PluginConfiguration = { plugins: {} };
      const merged = mergeConfigurations(orgConfig ?? defaultConfig, repoConfig ?? defaultConfig);

      console.log("✅ Config loaded successfully");
      return merged;
    }

    // Create a minimal OpenAI client for the event handler
    const { default: openai } = await import("openai");
    const llmClient = new openai({ apiKey: "dummy" }); // Not needed for config fetching

    // Create a GitHubEventHandler for app authentication
    const eventHandler = new GitHubEventHandler({
      environment: process.env.ENVIRONMENT ?? "development",
      webhookSecret: "dummy", // Not needed for config fetching
      appId: appId,
      privateKey: privateKey,
      llmClient: llmClient,
      llm: "dummy", // Not needed for config fetching
    });

    // Get an unauthenticated octokit first to find installations
    const unauthenticatedOctokit = eventHandler.getUnauthenticatedOctokit();

    // Find the installation for the org
    const installations = await unauthenticatedOctokit.rest.apps.listInstallations();
    const installation = installations.data.find((inst) => inst.account?.login === org);

    if (!installation) {
      console.log(`❌ No GitHub App installation found for organization: ${org}`);
      return null;
    }

    // Get authenticated octokit for the installation
    const authenticatedOctokit = eventHandler.getAuthenticatedOctokit(installation.id);

    // Create a mock GitHubContext like the kernel uses
    const mockContext = {
      octokit: authenticatedOctokit,
      eventHandler: eventHandler,
      logger: {
        debug: console.log,
        error: console.error,
        warn: console.warn,
        info: console.log,
        trace: console.log,
      },
      payload: {
        repository: {
          owner: { login: org },
          name: repo,
        },
      },
    };

    const config = await getConfig(mockContext);
    console.log(`✅ Config loaded successfully`);
    return config;
  } catch (error) {
    console.log(`❌ Failed to fetch config: ${error}`);
    return null;
  }
}

// Get plugins from config
function extractPluginsFromConfig(config: PluginConfiguration): Record<string, string> {
  const plugins: Record<string, string> = {};

  if (config.plugins) {
    for (const [pluginKey, pluginConfig] of Object.entries(config.plugins)) {
      if (typeof pluginKey !== "string") continue;
      if (typeof pluginConfig !== "object" || pluginConfig === null) continue;

      const isUrl = pluginKey.startsWith("http://") || pluginKey.startsWith("https://");
      const isDomain = !pluginKey.includes("://") && !pluginKey.includes("/") && pluginKey.includes(".");
      if (!isUrl && !isDomain) continue;

      plugins[pluginKey] = pluginKey;
    }
  }

  return plugins;
}

async function fetchPluginManifest(url: string): Promise<PluginManifest | null> {
  try {
    const response = await fetch(`${url}/manifest.json`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function dispatchToPlugin(url: string, payload: CommandPayload): Promise<unknown> {
  try {
    console.log(`📡 Dispatching to ${url}...`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.log(`❌ Plugin returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const result = await response.json();
    console.log(`✅ Plugin response:`, JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.log(`❌ Failed to dispatch to plugin: ${error}`);
    return null;
  }
}

async function processCommentWithRealPlugins(org: string, repo: string, commentBody: string, issueNumber: number = 1) {
  console.log(`🔍 Processing comment with real plugins: "${commentBody}"`);
  console.log(`📍 Repository: ${org}/${repo}`);
  console.log();

  const configCachePath = getConfigCachePath(org, repo);

  // Check for GitHub App credentials for real token generation
  const appId = process.env.APP_ID;
  const privateKey = process.env.APP_PRIVATE_KEY;
  let installationToken: string | null = null;
  let installationId: number | null = null;

  if (appId && privateKey) {
    try {
      // Create a minimal OpenAI client for the event handler
      const { default: openai } = await import("openai");
      const llmClient = new openai({ apiKey: "dummy" });

      // Create a GitHubEventHandler for app authentication
      const { GitHubEventHandler } = await import("../src/github/github-event-handler.js");
      const eventHandler = new GitHubEventHandler({
        environment: process.env.ENVIRONMENT ?? "development",
        webhookSecret: "dummy",
        appId: appId,
        privateKey: privateKey,
        llmClient: llmClient,
        llm: "dummy",
      });

      // Get an unauthenticated octokit first to find installations
      const unauthenticatedOctokit = eventHandler.getUnauthenticatedOctokit();

      // Find the installation for the org
      const installations = await unauthenticatedOctokit.rest.apps.listInstallations();
      const installation = installations.data.find((inst) => inst.account?.login === org);

      if (installation) {
        installationId = installation.id;
        installationToken = await eventHandler.getToken(installation.id);
        console.log(`🔑 Generated real installation token for ${org}`);
      } else {
        console.log(`⚠️  No GitHub App installation found for organization: ${org}, using mock token`);
      }
    } catch (error) {
      console.log(`⚠️  Failed to generate installation token: ${error}, using mock token`);
    }
  } else {
    console.log(`⚠️  GitHub App credentials not found; will use GITHUB_TOKEN if set`);
  }

  const githubToken = (process.env.GITHUB_TOKEN ?? "").trim();
  const authToken = installationToken || githubToken || "mock-token";
  if (!installationToken && githubToken) {
    console.log("🔑 Using GITHUB_TOKEN for auth");
  }

  const stateId = "test-state-id";
  let ubiquityKernelToken: string | undefined;
  if (authToken !== "mock-token" && privateKey) {
    const { signPayload } = await import("@ubiquity-os/plugin-sdk/signature");
    const { createKernelAttestationToken } = await import("../src/github/utils/kernel-attestation");
    ubiquityKernelToken = await createKernelAttestationToken({
      sign: (payload: string) => signPayload(payload, privateKey),
      owner: org,
      repo,
      installationId,
      authToken,
      stateId,
    });
  }

  // Load cached config
  const cachedConfig = loadCachedConfig(configCachePath);

  if (!cachedConfig) {
    console.log("📄 No cached config found. Fetching latest config from GitHub...");

    const latestConfig = await fetchLatestConfig(org, repo);
    if (!latestConfig) {
      console.log("❌ Failed to fetch config from GitHub. Please check your GITHUB_TOKEN and repository access.");
      const candidates = getConfigPathCandidatesForEnvironment(process.env.ENVIRONMENT ?? "development");
      console.log(`💡 Make sure you have ${candidates.join(" or ")} in the repository.`);
      return;
    }

    saveConfigToCache(configCachePath, latestConfig);
    console.log("✅ Config downloaded and cached. Please rerun the command to use the cached config.");
    return;
  }

  console.log("📄 Loaded cached config");

  // Extract plugins from config
  const plugins = extractPluginsFromConfig(cachedConfig);
  console.log(`🔌 Found ${Object.keys(plugins).length} plugins in config`);

  // Update cache in background (don't wait for it)
  fetchLatestConfig(org, repo)
    .then((latestConfig) => {
      if (latestConfig) {
        saveConfigToCache(configCachePath, latestConfig);
      }
    })
    .catch((error) => {
      console.log(`⚠️  Failed to update cache in background: ${error}`);
    });

  console.log("📄 Loading plugin configurations...");

  // Check which plugins are available
  const availablePlugins: Record<string, PluginManifest> = {};
  for (const [pluginKey, pluginName] of Object.entries(plugins)) {
    // For now, assume pluginKey is the URL - we can enhance this later
    const url = pluginKey.startsWith("http") ? pluginKey : `https://${pluginKey}`;

    console.log(`🔍 Checking ${pluginName} at ${url}...`);
    const manifest = await fetchPluginManifest(url);
    if (manifest) {
      availablePlugins[url] = manifest;
      console.log(`✅ ${pluginName} is available`);
    } else {
      console.log(`❌ ${pluginName} is not available`);
    }
  }

  console.log();

  // Process the comment
  if (commentBody.startsWith("/")) {
    const rawArgs = commentBody.slice(1).split(" ");
    const command = rawArgs[0];
    const commandArgs = rawArgs.slice(1).join(" ").trim();
    console.log(`🎯 Detected command: ${command}`);

    // Find plugin that handles this command
    let isHandled = false;
    for (const [url, manifest] of Object.entries(availablePlugins)) {
      if (manifest.commands && manifest.commands[command]) {
        console.log(`🔌 Routing to ${manifest.name} (${url})`);

        const parameters: Record<string, unknown> = {};
        if (command === "llm") {
          parameters.prompt = commandArgs;
        }

        // Format the payload as expected by plugins (matching kernel dispatch format)
        const eventPayloadJson = JSON.stringify({
          repository: { owner: { login: org }, name: repo },
          issue: { number: issueNumber },
          comment: { body: commentBody },
          ...(installationId !== null ? { installation: { id: installationId } } : {}),
        });

        const kernelPayload = {
          command: JSON.stringify({ name: command, parameters }),
          eventPayload: compressString(eventPayloadJson),
          settings: JSON.stringify({}),
          authToken,
          ubiquityKernelToken,
          stateId,
          eventName: "issue_comment.created",
          ref: "main",
        };

        await dispatchToPlugin(url, kernelPayload);
        isHandled = true;
        break;
      }
    }

    if (!isHandled) {
      console.log(`❓ No plugin found for command: ${command}`);
    }
  } else if (commentBody.includes("@UbiquityOS")) {
    console.log("🤖 Detected AI query - would route to command-ask plugin");
    console.log("⚠️ AI processing not implemented in this test tool");
  } else {
    console.log("💭 Comment doesn't trigger any plugins");
  }

  console.log();
  console.log("🎉 Processing complete!");
}

// Parse GitHub URL to extract org, repo, and issue number
function parseGitHubUrl(url: string): { org: string; repo: string; issueNumber: number } | null {
  try {
    const urlPattern = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
    const match = url.match(urlPattern);

    if (match) {
      return {
        org: match[1],
        repo: match[2],
        issueNumber: parseInt(match[3], 10),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: bun run scripts/test-command.ts <command> <github-url> [command-args...]");
    console.log("Examples:");
    console.log("  bun run scripts/test-command.ts hello https://github.com/0x4007/ubiquity-os-sandbox/issues/2");
    console.log("  bun run scripts/test-command.ts llm https://github.com/0x4007/ubiquity-os-sandbox/issues/8 tell me a short joke");
    process.exit(1);
  }

  const [command, githubUrl, ...commandArgs] = args;

  // Parse GitHub URL
  const parsedUrl = parseGitHubUrl(githubUrl);
  if (!parsedUrl) {
    console.log(`❌ Invalid GitHub URL format: ${githubUrl}`);
    console.log("Expected: https://github.com/org/repo/issues/number");
    process.exit(1);
  }

  const { org, repo, issueNumber } = parsedUrl;
  console.log(`🎯 Targeting issue #${issueNumber} in ${org}/${repo}`);

  const commentBody = commandArgs.length > 0 ? `/${command} ${commandArgs.join(" ")}` : `/${command}`;
  await processCommentWithRealPlugins(org, repo, commentBody, issueNumber);
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
