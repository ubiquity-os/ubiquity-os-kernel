#!/usr/bin/env bun

// CLI to test kernel comment processing with real plugin execution
// This allows debugging and developing plugins with actual command execution

import { compressString } from "@ubiquity-os/plugin-sdk/compression";
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import YAML from "js-yaml";

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

// Cache configuration
const CACHE_DIR = ".test-cache";
const CONFIG_CACHE_PATH = join(CACHE_DIR, "config.yml");

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// Load cached config
function loadCachedConfig(): PluginConfiguration | null {
  try {
    if (existsSync(CONFIG_CACHE_PATH)) {
      const data = readFileSync(CONFIG_CACHE_PATH, "utf8");
      return YAML.load(data) as PluginConfiguration;
    }
  } catch (error) {
    console.log(`⚠️  Failed to load cached config: ${error}`);
  }
  return null;
}

// Save config to cache
function saveConfigToCache(config: PluginConfiguration): void {
  try {
    const yamlData = YAML.dump(config);
    writeFileSync(CONFIG_CACHE_PATH, yamlData, "utf8");
    console.log(`💾 Config cached to ${CONFIG_CACHE_PATH}`);
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
      console.log("❌ GitHub App credentials not found. Set APP_ID and APP_PRIVATE_KEY environment variables.");
      return null;
    }

    // Create a minimal OpenAI client for the event handler
    const { default: openai } = await import("openai");
    const llmClient = new openai({ apiKey: "dummy" }); // Not needed for config fetching

    // Create a GitHubEventHandler for app authentication
    const eventHandler = new GitHubEventHandler({
      environment: "development",
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
      // Extract the plugin URL/name mapping
      if (typeof pluginConfig === "object" && pluginConfig !== null) {
        // For now, just map the key to itself - we can enhance this later
        plugins[pluginKey] = pluginKey;
      }
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

  // Check for GitHub App credentials for real token generation
  const appId = process.env.APP_ID;
  const privateKey = process.env.APP_PRIVATE_KEY;
  let installationToken: string | null = null;

  if (appId && privateKey) {
    try {
      // Create a minimal OpenAI client for the event handler
      const { default: openai } = await import("openai");
      const llmClient = new openai({ apiKey: "dummy" });

      // Create a GitHubEventHandler for app authentication
      const { GitHubEventHandler } = await import("../src/github/github-event-handler.js");
      const eventHandler = new GitHubEventHandler({
        environment: "development",
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
        installationToken = await eventHandler.getToken(installation.id);
        console.log(`🔑 Generated real installation token for ${org}`);
      } else {
        console.log(`⚠️  No GitHub App installation found for organization: ${org}, using mock token`);
      }
    } catch (error) {
      console.log(`⚠️  Failed to generate installation token: ${error}, using mock token`);
    }
  } else {
    console.log(`⚠️  GitHub App credentials not found, using mock token`);
  }

  // Load cached config
  const cachedConfig = loadCachedConfig();

  if (!cachedConfig) {
    console.log("📄 No cached config found. Fetching latest config from GitHub...");

    const latestConfig = await fetchLatestConfig(org, repo);
    if (!latestConfig) {
      console.log("❌ Failed to fetch config from GitHub. Please check your GITHUB_TOKEN and repository access.");
      console.log("💡 Make sure you have a .github/.ubiquity-os.config.yml or .github/.ubiquity-os.config.dev.yml file in the repository.");
      return;
    }

    saveConfigToCache(latestConfig);
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
        saveConfigToCache(latestConfig);
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
    const command = commentBody.slice(1).split(" ")[0];
    console.log(`🎯 Detected command: ${command}`);

    // Find plugin that handles this command
    let isHandled = false;
    for (const [url, manifest] of Object.entries(availablePlugins)) {
      if (manifest.commands && manifest.commands[command]) {
        console.log(`🔌 Routing to ${manifest.name} (${url})`);

        // Format the payload as expected by plugins (matching kernel dispatch format)
        const eventPayloadJson = JSON.stringify({
          repository: { owner: { login: org }, name: repo },
          issue: { number: issueNumber },
        });

        const kernelPayload = {
          command: JSON.stringify({ name: command, parameters: {} }),
          eventPayload: compressString(eventPayloadJson),
          settings: JSON.stringify({}),
          authToken: installationToken || "mock-token",
          stateId: "test-state-id",
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

  if (args.length !== 2) {
    console.log("Usage: bun run scripts/test-command.ts <command> <github-url>");
    console.log("Examples:");
    console.log("  bun run scripts/test-command.ts hello https://github.com/0x4007/ubiquity-os-sandbox/issues/2");
    console.log("  bun run scripts/test-command.ts help https://github.com/0x4007/ubiquity-os-sandbox/issues/5");
    process.exit(1);
  }

  const [command, githubUrl] = args;

  // Parse GitHub URL
  const parsedUrl = parseGitHubUrl(githubUrl);
  if (!parsedUrl) {
    console.log(`❌ Invalid GitHub URL format: ${githubUrl}`);
    console.log("Expected: https://github.com/org/repo/issues/number");
    process.exit(1);
  }

  const { org, repo, issueNumber } = parsedUrl;
  console.log(`🎯 Targeting issue #${issueNumber} in ${org}/${repo}`);

  await processCommentWithRealPlugins(org, repo, `/${command}`, issueNumber);
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
