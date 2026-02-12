import type { PluginConfiguration } from "../github/types/plugin-configuration.ts";

export type TelegramMode = "github" | "shim";

export type TelegramChannelConfig = Readonly<{
  mode: TelegramMode;
  owner: string;
  repo?: string;
  issueNumber?: number;
  installationId?: number;
}>;

export type TelegramChannelConfigResult =
  | {
      ok: true;
      config: TelegramChannelConfig;
    }
  | { ok: false; error: string };

const TELEGRAM_CONFIG_HINT = "Add channels.telegram to .github/.ubiquity-os.config.yml in your .ubiquity-os repo.";

export type TelegramChannelConfigParseOptions = Readonly<{
  /**
   * Linked Telegram identities already resolve a GitHub owner. When config omits
   * `channels.telegram.owner` (or `channels.telegram` entirely), we can safely
   * default to that effective owner.
   */
  fallbackOwner?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.trunc(parsed);
    return normalized > 0 ? normalized : undefined;
  }
  return undefined;
}

export function parseTelegramChannelConfig(config: PluginConfiguration, options: TelegramChannelConfigParseOptions = {}): TelegramChannelConfigResult {
  const root = config as Record<string, unknown>;
  const channels = isRecord(root.channels) ? root.channels : null;
  const telegram = channels && isRecord(channels.telegram) ? channels.telegram : null;

  // If `channels.telegram` is absent, we default to shim mode. This matches the
  // workspace/topical routing flow where `/topic` sets per-chat context.
  const defaultMode: TelegramMode = telegram ? "github" : "shim";
  const modeRaw = telegram ? normalizeOptionalString(telegram.mode) : undefined;
  const mode = (modeRaw ? modeRaw.toLowerCase() : defaultMode) as TelegramMode;
  if (mode !== "github" && mode !== "shim") {
    return {
      ok: false,
      error: "channels.telegram.mode must be 'github' or 'shim'.",
    };
  }

  const owner = normalizeOptionalString(telegram?.owner) ?? normalizeOptionalString(options.fallbackOwner);
  if (!owner) {
    return telegram
      ? { ok: false, error: "channels.telegram.owner is required." }
      : {
          ok: false,
          error: `Telegram config missing. ${TELEGRAM_CONFIG_HINT} (or provide a fallback owner).`,
        };
  }

  const repo = telegram ? normalizeOptionalString(telegram.repo) : undefined;
  const issueNumber = telegram ? parseOptionalPositiveInt(telegram.issueNumber) : undefined;
  const installationId = telegram ? parseOptionalPositiveInt(telegram.installationId) : undefined;

  if (mode === "github") {
    if (!repo) {
      return {
        ok: false,
        error: "channels.telegram.repo is required in github mode.",
      };
    }
    if (!issueNumber) {
      return {
        ok: false,
        error: "channels.telegram.issueNumber is required in github mode.",
      };
    }
  }

  return {
    ok: true,
    config: {
      mode,
      owner,
      ...(repo ? { repo } : {}),
      ...(issueNumber ? { issueNumber } : {}),
      ...(installationId ? { installationId } : {}),
    },
  };
}
