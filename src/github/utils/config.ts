import {
  ConfigurationHandler,
  CONFIG_DEV_FULL_PATH,
  CONFIG_ORG_REPO as SDK_CONFIG_ORG_REPO,
  CONFIG_PROD_FULL_PATH,
} from "@ubiquity-os/plugin-sdk/configuration";
import type { YAMLException } from "js-yaml";
import type { ValueError } from "@sinclair/typebox/value";
import { GitHubContext } from "../github-context.ts";
import type { PluginConfiguration } from "../types/plugin-configuration.ts";
import { tryGetInstallationIdForOwner } from "./marketplace-auth.ts";

export const CONFIG_FULL_PATH = CONFIG_PROD_FULL_PATH;
export const DEV_CONFIG_FULL_PATH = CONFIG_DEV_FULL_PATH;
export const CONFIG_ORG_REPO = SDK_CONFIG_ORG_REPO;

const ENVIRONMENT_TO_CONFIG_SUFFIX: Record<string, string> = {
  development: "dev", // backwards compatible with previous ENVIRONMENT value
};

const VALID_CONFIG_SUFFIX = /^[a-z0-9][a-z0-9_-]*$/i;

type ConfigLocation = { owner: string; repo: string };
export type ConfigSource = { owner: string; repo: string; path: string; sha?: string | null };

type ConfigurationErrors = (YAMLException | ValueError)[];

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

/**
 * Returns ordered config path candidates for an environment (primary + fallback).
 */
export function getConfigPathCandidatesForEnvironment(environment: string | null | undefined): string[] {
  const primary = getConfigFullPathForEnvironment(environment);
  return primary === CONFIG_FULL_PATH ? [CONFIG_FULL_PATH] : [primary, CONFIG_FULL_PATH];
}

function readPayloadOwner(context: GitHubContext): string | null {
  const payload = context.payload as Record<string, unknown>;
  const repository = payload.repository as { owner?: { login?: unknown } } | undefined;
  const owner = repository?.owner?.login;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

function normalizeConfigurationErrors(errors: unknown): ConfigurationErrors | null {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors as ConfigurationErrors;
  if (typeof (errors as { [Symbol.iterator]?: unknown })?.[Symbol.iterator] === "function") {
    return [...(errors as Iterable<unknown>)] as ConfigurationErrors;
  }
  return null;
}

function createConfigurationHandler(context: GitHubContext): ConfigurationHandler {
  const environment = normalizeEnvironmentName(context.eventHandler.environment);
  return new ConfigurationHandler(context.logger, context.octokit, environment || null, {
    octokitFactory: async (location: ConfigLocation) => {
      const payloadOwner = readPayloadOwner(context);
      if (payloadOwner && payloadOwner.toLowerCase() === location.owner.trim().toLowerCase()) {
        return context.octokit;
      }
      if (typeof context.eventHandler.getAuthenticatedOctokit !== "function") {
        return null;
      }
      const installationId = await tryGetInstallationIdForOwner(context.eventHandler, location.owner);
      if (installationId === null) {
        return null;
      }
      return context.eventHandler.getAuthenticatedOctokit(installationId);
    },
  });
}

/**
 * Fetches and validates configuration for a single repository.
 */
export async function getConfigurationFromRepo(context: GitHubContext, repository: string, owner: string) {
  const handler = createConfigurationHandler(context);
  const { config, errors, rawData } = await handler.getConfigurationFromRepo(owner, repository);
  return {
    config: (config ?? null) as PluginConfiguration | null,
    errors: normalizeConfigurationErrors(errors),
    rawData: rawData ?? null,
    source: null as ConfigSource | null,
  };
}

/**
 * Loads and merges org/repo configuration for the event context.
 */
export async function getConfig(context: GitHubContext): Promise<PluginConfiguration> {
  const payload = context.payload;
  const repository =
    typeof payload === "object" && payload && "repository" in payload && payload.repository && typeof payload.repository === "object"
      ? (payload.repository as { owner?: { login?: unknown }; name?: unknown })
      : null;
  const owner = typeof repository?.owner?.login === "string" ? repository.owner.login.trim() : "";
  const repo = typeof repository?.name === "string" ? repository.name.trim() : "";

  const handler = createConfigurationHandler(context);
  if (!owner || !repo) {
    context.logger.warn("Repository or owner is not defined");
    return (await handler.getConfiguration()) as PluginConfiguration;
  }

  const resolved = (await handler.getConfiguration({ owner, repo })) as PluginConfiguration & { __sources?: ConfigSource[] };
  if (!resolved.__sources) {
    resolved.__sources = [];
  }
  return resolved;
}
