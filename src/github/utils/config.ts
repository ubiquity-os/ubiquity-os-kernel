import { TransformDecodeCheckError, Value, ValueError } from "@sinclair/typebox/value";
import YAML from "js-yaml";
import { YAMLError } from "yaml";
import { Buffer } from "node:buffer";
import { GitHubContext } from "../github-context";
import { GithubPlugin, PluginConfiguration, PluginSettings, configSchema, configSchemaValidator, parsePluginIdentifier } from "../types/plugin-configuration";
import { tryGetInstallationIdForOwner } from "./marketplace-auth";
import { getManifest } from "./plugins";

export const CONFIG_FULL_PATH = ".github/.ubiquity-os.config.yml";
export const DEV_CONFIG_FULL_PATH = ".github/.ubiquity-os.config.dev.yml";
export const CONFIG_ORG_REPO = ".ubiquity-os";

const ENVIRONMENT_TO_CONFIG_SUFFIX: Record<string, string> = {
  development: "dev", // backwards compatible with previous ENVIRONMENT value
};

const VALID_CONFIG_SUFFIX = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_IMPORT_DEPTH = 6;

type ConfigLocation = { owner: string; repo: string; environment?: string | null };
export type ConfigSource = { owner: string; repo: string; path: string; sha?: string | null };
type ImportState = {
  cache: Map<string, PluginConfiguration | null>;
  inFlight: Set<string>;
  octokitByOwner: Map<string, GitHubContext["octokit"] | null>;
};

function normalizeEnvironmentName(environment: string | null | undefined): string {
  return String(environment ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Returns the config file path that corresponds to the running environment.
 *
 * - `production` -> `.github/.ubiquity-os.config.yml`
 * - `<env>` -> `.github/.ubiquity-os.config.<env>.yml`
 * - `development` (legacy) -> `.github/.ubiquity-os.config.dev.yml`
 */
export function getConfigFullPathForEnvironment(environment: string | null | undefined): string {
  const normalized = normalizeEnvironmentName(environment);
  if (!normalized) {
    return DEV_CONFIG_FULL_PATH;
  }
  if (normalized === "production" || normalized === "prod") {
    return CONFIG_FULL_PATH;
  }

  const suffix = ENVIRONMENT_TO_CONFIG_SUFFIX[normalized] ?? normalized;
  if (suffix === "dev") {
    return DEV_CONFIG_FULL_PATH;
  }

  if (!VALID_CONFIG_SUFFIX.test(suffix)) {
    return DEV_CONFIG_FULL_PATH;
  }

  return `.github/.ubiquity-os.config.${suffix}.yml`;
}

export function getConfigPathCandidatesForEnvironment(environment: string | null | undefined): string[] {
  const primary = getConfigFullPathForEnvironment(environment);
  return primary === CONFIG_FULL_PATH ? [CONFIG_FULL_PATH] : [primary, CONFIG_FULL_PATH];
}

function normalizeImportKey(location: ConfigLocation): string {
  const env = normalizeEnvironmentName(location.environment ?? "") || "default";
  return `${location.owner}`.trim().toLowerCase() + "/" + `${location.repo}`.trim().toLowerCase() + "@" + env;
}

function parseImportSpec(value: string): ConfigLocation | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const [repoSpec, envSpecRaw] = trimmed.split("@");
  const parts = repoSpec.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  const envSpec = envSpecRaw?.trim();
  if (envSpec && !VALID_CONFIG_SUFFIX.test(envSpec)) {
    return null;
  }
  return { owner, repo, environment: envSpec || undefined };
}

function readImports(context: GitHubContext, value: unknown, source: ConfigLocation): ConfigLocation[] {
  if (!value) return [];
  if (!Array.isArray(value)) {
    context.logger.warn({ source }, "Invalid imports; expected a list of strings.");
    return [];
  }
  const seen = new Set<string>();
  const imports: ConfigLocation[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      context.logger.warn({ source, entry }, "Ignoring invalid import entry; expected string.");
      continue;
    }
    const parsed = parseImportSpec(entry);
    if (!parsed) {
      context.logger.warn({ source, entry }, "Ignoring invalid import entry; expected owner/repo.");
      continue;
    }
    const key = normalizeImportKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    imports.push(parsed);
  }
  return imports;
}

function normalizeConfiguration(context: GitHubContext, source: ConfigLocation, yaml: unknown) {
  if (!yaml || typeof yaml !== "object" || Array.isArray(yaml)) {
    return { config: yaml as PluginConfiguration | null, imports: [] as ConfigLocation[] };
  }
  let targetRepoConfiguration: PluginConfiguration | null = yaml as PluginConfiguration;
  const imports = readImports(context, (yaml as { imports?: unknown }).imports, source);
  if ("imports" in (yaml as { imports?: unknown })) {
    delete (yaml as { imports?: unknown }).imports;
  }

  // Handle new array format: convert to old object format
  if (targetRepoConfiguration && Array.isArray(targetRepoConfiguration.plugins)) {
    context.logger.debug({ source }, "Converting array-format plugins to object format");
    const convertedPlugins: Record<string, PluginSettings> = {};
    type LegacyPluginUse = { plugin?: string } & Record<string, unknown>;
    type LegacyPluginItem = { uses?: LegacyPluginUse[] };
    for (let i = 0; i < targetRepoConfiguration.plugins.length; i++) {
      const pluginItem = targetRepoConfiguration.plugins[i] as LegacyPluginItem | null;
      if (!pluginItem?.uses || !Array.isArray(pluginItem.uses)) continue;
      for (const use of pluginItem.uses) {
        if (!use || typeof use !== "object") continue;
        const pluginKey = typeof use.plugin === "string" ? use.plugin : null;
        if (!pluginKey) continue;
        const pluginConfig = { ...use } as LegacyPluginUse;
        delete pluginConfig.plugin;
        convertedPlugins[pluginKey] = pluginConfig as PluginSettings;
      }
    }
    targetRepoConfiguration = {
      ...targetRepoConfiguration,
      plugins: convertedPlugins,
    };
  }

  return { config: targetRepoConfiguration, imports };
}

function stripImports(config: PluginConfiguration): PluginConfiguration {
  if (!config || typeof config !== "object") return config;
  const { imports: _imports, ...rest } = config as PluginConfiguration & { imports?: unknown };
  return rest as PluginConfiguration;
}

function mergeImportedConfigs(imported: PluginConfiguration[], base: PluginConfiguration | null): PluginConfiguration | null {
  if (!imported.length) {
    return base;
  }
  let merged = imported[0];
  for (let i = 1; i < imported.length; i++) {
    merged = mergeConfigurations(merged, imported[i]);
  }
  return base ? mergeConfigurations(merged, base) : merged;
}

function createImportState(): ImportState {
  return {
    cache: new Map(),
    inFlight: new Set(),
    octokitByOwner: new Map(),
  };
}

async function getOctokitForOwner(context: GitHubContext, owner: string, state: ImportState): Promise<GitHubContext["octokit"] | null> {
  const key = owner.trim().toLowerCase();
  if (state.octokitByOwner.has(key)) {
    return state.octokitByOwner.get(key) ?? null;
  }
  const repoOwner =
    typeof context.payload === "object" &&
    context.payload !== null &&
    "repository" in context.payload &&
    context.payload.repository &&
    typeof context.payload.repository === "object" &&
    "owner" in context.payload.repository &&
    context.payload.repository.owner &&
    typeof context.payload.repository.owner === "object" &&
    "login" in context.payload.repository.owner
      ? context.payload.repository.owner.login
      : null;
  if (repoOwner && repoOwner.toLowerCase() === key) {
    state.octokitByOwner.set(key, context.octokit);
    return context.octokit;
  }

  if (typeof context.eventHandler.getAuthenticatedOctokit !== "function") {
    context.logger.debug({ owner }, "No authenticated Octokit resolver available for imports.");
    state.octokitByOwner.set(key, null);
    return null;
  }

  const installationId = await tryGetInstallationIdForOwner(context.eventHandler, owner);
  if (installationId === null) {
    context.logger.debug({ owner }, "No installation found for import owner.");
    state.octokitByOwner.set(key, null);
    return null;
  }

  const octokit = context.eventHandler.getAuthenticatedOctokit(installationId);
  state.octokitByOwner.set(key, octokit);
  return octokit;
}

async function loadConfigSource(
  context: GitHubContext,
  location: ConfigLocation,
  octokit: GitHubContext["octokit"]
): Promise<{ config: PluginConfiguration | null; imports: ConfigLocation[]; errors: YAMLError[] | null; rawData: string | null; source: ConfigSource | null }> {
  const environment = location.environment ?? context.eventHandler.environment;
  const downloaded = await download({
    context,
    repository: location.repo,
    owner: location.owner,
    octokit,
    environment,
  });

  if (!downloaded) {
    context.logger.debug({ owner: location.owner, repository: location.repo }, "No configuration data");
    return { config: null, imports: [], errors: null, rawData: null, source: null };
  }
  const { data: rawData, source } = downloaded;
  context.logger.debug({ owner: location.owner, repository: location.repo }, "Downloaded configuration file");

  const { yaml, errors } = parseYaml(context, rawData);
  const { config, imports } = normalizeConfiguration(context, location, yaml);
  return { config, imports, errors, rawData, source };
}

function decodeConfiguration(
  context: GitHubContext,
  location: ConfigLocation,
  config: PluginConfiguration
): { config: PluginConfiguration | null; errors: ValueError[] | null } {
  context.logger.debug({ owner: location.owner, repository: location.repo }, "Decoding configuration");
  try {
    const configSchemaWithDefaults = Value.Default(configSchema, config) as Readonly<unknown>;
    const errors = configSchemaValidator.testReturningErrors(configSchemaWithDefaults);
    const errorList = errors ? [...errors] : null;
    if (errorList !== null) {
      for (const error of errorList) {
        context.logger.error({ err: error }, "Configuration validation error");
      }
    }
    const decodedConfig = Value.Decode(configSchema, configSchemaWithDefaults);
    return { config: stripImports(decodedConfig), errors: errorList };
  } catch (error) {
    context.logger.error({ err: error, owner: location.owner, repository: location.repo }, "Error decoding configuration; Will ignore.");
    return { config: null, errors: [error instanceof TransformDecodeCheckError ? error.error : error] as ValueError[] };
  }
}

async function resolveImportedConfiguration(
  context: GitHubContext,
  location: ConfigLocation,
  state: ImportState,
  depth: number
): Promise<PluginConfiguration | null> {
  const key = normalizeImportKey(location);
  if (state.cache.has(key)) {
    return state.cache.get(key) ?? null;
  }
  if (state.inFlight.has(key)) {
    context.logger.warn({ location }, "Skipping import due to circular reference.");
    return null;
  }
  if (depth > MAX_IMPORT_DEPTH) {
    context.logger.warn({ location, depth }, "Skipping import; maximum depth exceeded.");
    return null;
  }
  state.inFlight.add(key);

  let resolved: PluginConfiguration | null = null;
  try {
    const octokit = await getOctokitForOwner(context, location.owner, state);
    if (!octokit) {
      context.logger.warn({ location }, "Skipping import; no authorized Octokit for owner.");
      return null;
    }
    const { config, imports, errors } = await loadConfigSource(context, location, octokit);
    if (errors && errors.length) {
      context.logger.warn({ location, errors }, "Skipping import due to YAML parsing errors.");
      return null;
    }
    if (!config) {
      return null;
    }
    const importedConfigs: PluginConfiguration[] = [];
    for (const next of imports) {
      const nested = await resolveImportedConfiguration(context, next, state, depth + 1);
      if (nested) importedConfigs.push(nested);
    }
    const mergedConfig = mergeImportedConfigs(importedConfigs, config);
    if (!mergedConfig) return null;
    const decoded = decodeConfiguration(context, location, mergedConfig);
    resolved = decoded.config;
  } finally {
    state.inFlight.delete(key);
    state.cache.set(key, resolved);
  }

  return resolved;
}

export async function getConfigurationFromRepo(context: GitHubContext, repository: string, owner: string) {
  const location = { owner, repo: repository };
  const state = createImportState();
  const octokit = await getOctokitForOwner(context, owner, state);
  if (!octokit) {
    context.logger.debug({ owner, repository }, "No authorized Octokit for configuration load.");
    return { config: null, errors: null, rawData: null, source: null };
  }

  const { config, imports, errors, rawData, source } = await loadConfigSource(context, location, octokit);
  if (!rawData) {
    return { config: null, errors: null, rawData: null, source: null };
  }
  if (errors && errors.length) {
    context.logger.error({ owner, repository, errors }, "YAML could not be decoded");
    return { config: null, errors, rawData, source };
  }
  if (!config) {
    context.logger.error({ owner, repository }, "YAML could not be decoded");
    return { config: null, errors, rawData, source };
  }

  const importedConfigs: PluginConfiguration[] = [];
  for (const next of imports) {
    const resolved = await resolveImportedConfiguration(context, next, state, 1);
    if (resolved) importedConfigs.push(resolved);
  }
  const mergedConfig = mergeImportedConfigs(importedConfigs, config);
  if (!mergedConfig) {
    return { config: null, errors: null, rawData };
  }

  const decoded = decodeConfiguration(context, location, mergedConfig);
  return { config: decoded.config, errors: decoded.errors, rawData, source };
}

/**
 * Merge configurations based on their 'plugins' keys
 */
function mergeConfigurations(configuration1: PluginConfiguration, configuration2: PluginConfiguration): PluginConfiguration {
  const mergedPlugins = {
    ...(configuration1.plugins ?? {}),
    ...(configuration2.plugins ?? {}),
  };
  return {
    ...configuration1,
    ...configuration2,
    plugins: mergedPlugins,
  };
}

export async function getConfig(context: GitHubContext): Promise<PluginConfiguration> {
  const payload = context.payload;
  const defaultConfiguration = stripImports(Value.Decode(configSchema, Value.Default(configSchema, {})));
  if (!("repository" in payload) || !payload.repository) {
    context.logger.warn("Repository is not defined");
    return defaultConfiguration;
  }
  if (!("owner" in payload.repository) || !payload.repository.owner) {
    context.logger.warn("Owner is not defined");
    return defaultConfiguration;
  }

  let mergedConfiguration: PluginConfiguration = defaultConfiguration;

  context.logger.debug(
    {
      orgRepo: `${payload.repository.owner.login}/${CONFIG_ORG_REPO}`,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
    },
    "Fetching configurations"
  );
  const orgConfig = await getConfigurationFromRepo(context, CONFIG_ORG_REPO, payload.repository.owner.login);
  const repoConfig = await getConfigurationFromRepo(context, payload.repository.name, payload.repository.owner.login);
  const configSources: ConfigSource[] = [];
  if (orgConfig.source) configSources.push(orgConfig.source);
  if (repoConfig.source) configSources.push(repoConfig.source);

  context.logger.debug({ repo: `${payload.repository.owner.login}/${payload.repository.name}` }, "Fetched configurations; Will merge them.");

  if (orgConfig.config) {
    mergedConfiguration = mergeConfigurations(mergedConfiguration, orgConfig.config);
  }
  if (repoConfig.config) {
    mergedConfiguration = mergeConfigurations(mergedConfiguration, repoConfig.config);
  }

  const resolvedPlugins: Record<string, PluginSettings> = {};

  context.logger.debug(
    { repo: `${payload.repository.owner.login}/${payload.repository.name}`, plugins: Object.keys(mergedConfiguration.plugins).length },
    "Found plugins enabled"
  );

  for (const [pluginKey, pluginSettings] of Object.entries(mergedConfiguration.plugins)) {
    let pluginIdentifier: string | GithubPlugin;
    try {
      pluginIdentifier = parsePluginIdentifier(pluginKey);
    } catch (error) {
      context.logger.error({ plugin: pluginKey, err: error }, "Invalid plugin identifier; skipping");
      continue;
    }

    const manifest = await getManifest(context, pluginIdentifier);

    let runsOn = pluginSettings?.runsOn ?? [];
    let shouldSkipBotEvents = pluginSettings?.skipBotEvents;

    if (manifest) {
      if (!runsOn.length) {
        runsOn = manifest["ubiquity:listeners"] ?? [];
      }
      if (shouldSkipBotEvents === undefined) {
        shouldSkipBotEvents = manifest.skipBotEvents ?? true;
      }
    }

    resolvedPlugins[pluginKey] = {
      ...pluginSettings,
      with: pluginSettings?.with ?? {},
      runsOn,
      skipBotEvents: shouldSkipBotEvents,
    };
  }

  const resolved = {
    ...mergedConfiguration,
    plugins: resolvedPlugins,
  } as PluginConfiguration & { __sources?: ConfigSource[] };
  if (configSources.length) {
    resolved.__sources = configSources;
  }
  return resolved;
}

async function download({
  context,
  repository,
  owner,
  octokit,
  environment,
}: {
  context: GitHubContext;
  repository: string;
  owner: string;
  octokit: GitHubContext["octokit"];
  environment?: string | null;
}): Promise<{ data: string; source: ConfigSource } | null> {
  if (!repository || !owner) {
    context.logger.error("Repo or owner is not defined, cannot download the requested file");
    return null;
  }
  const candidates = getConfigPathCandidatesForEnvironment(environment ?? context.eventHandler.environment);
  for (const filePath of candidates) {
    try {
      context.logger.debug({ owner, repository, filePath }, "Attempting to fetch configuration");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
      try {
        const { data, headers } = await octokit.rest.repos.getContent({
          owner,
          repo: repository,
          path: filePath,
          request: { signal: controller.signal },
        });
        if (typeof data === "string") {
          context.logger.debug({ owner, repository, filePath, rateLimitRemaining: headers?.["x-ratelimit-remaining"] }, "Configuration file found");
          return { data, source: { owner, repo: repository, path: filePath, sha: null } };
        }
        if (!data || Array.isArray(data) || typeof data !== "object") {
          context.logger.warn({ owner, repository, filePath }, "Unexpected configuration payload type");
          return null;
        }
        if ("content" in data && typeof data.content === "string") {
          const encoding = "encoding" in data && typeof data.encoding === "string" ? data.encoding : "base64";
          const decoded = encoding.toLowerCase() === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
          const sha = "sha" in data && typeof data.sha === "string" ? data.sha : null;
          context.logger.debug({ owner, repository, filePath, rateLimitRemaining: headers?.["x-ratelimit-remaining"], sha }, "Configuration file found");
          return { data: decoded, source: { owner, repo: repository, path: filePath, sha } };
        }
        context.logger.warn({ owner, repository, filePath }, "Configuration content missing or invalid");
        return null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err && typeof err === "object" && "status" in err && err.status === 404) {
        context.logger.debug({ owner, repository, filePath }, "No configuration file found");
        continue;
      }
      context.logger.error({ err, owner, repository, filePath }, "Failed to download the requested file");
      return null;
    }
  }
  return null;
}

export function parseYaml(context: GitHubContext, data: null | string) {
  context.logger.trace({ data }, "Will attempt to parse YAML data");
  try {
    if (data) {
      const parsedData = YAML.load(data);
      context.logger.trace({ parsedData }, "Parsed yaml data");
      return { yaml: parsedData ?? null, errors: null };
    }
  } catch (error) {
    context.logger.error({ error }, "Error parsing YAML");
    return { errors: [error] as YAMLError[], yaml: null };
  }
  context.logger.debug("Could not parse YAML");
  return { yaml: null, errors: null };
}
