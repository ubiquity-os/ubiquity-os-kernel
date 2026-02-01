import type { PluginConfiguration } from "../github/types/plugin-configuration.ts";

export type TelegramMode = "github" | "shim";

export type TelegramChannelConfig = Readonly<{
  mode: TelegramMode;
  owner: string;
  repo?: string;
  issueNumber?: number;
  installationId?: number;
}>;

export type TelegramChannelConfigResult = { ok: true; config: TelegramChannelConfig } | { ok: false; error: string };

const TELEGRAM_CONFIG_HINT = "Add channels.telegram to .github/.ubiquity-os.config.yml in your .ubiquity-os repo.";

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

export function parseTelegramChannelConfig(config: PluginConfiguration, ownerFallback: string): TelegramChannelConfigResult {
  const root = isRecord(config) ? config : {};
  const channels = isRecord(root.channels) ? root.channels : null;
  const telegram = channels && isRecord(channels.telegram) ? channels.telegram : null;
  if (!telegram) {
    const owner = ownerFallback;
    if (!owner) {
      return { ok: false, error: `Telegram config missing. ${TELEGRAM_CONFIG_HINT}` };
    }
    return {
      ok: true,
      config: {
        mode: "shim",
        owner,
      },
    };
  }

  const modeRaw = normalizeOptionalString(telegram.mode);
  const mode = (modeRaw ? modeRaw.toLowerCase() : "github") as TelegramMode;
  if (mode !== "github" && mode !== "shim") {
    return { ok: false, error: "channels.telegram.mode must be 'github' or 'shim'." };
  }

  const owner = normalizeOptionalString(telegram.owner) ?? ownerFallback;
  if (!owner) {
    return { ok: false, error: "channels.telegram.owner is required." };
  }

  const repo = normalizeOptionalString(telegram.repo);
  const issueNumber = parseOptionalPositiveInt(telegram.issueNumber);
  const installationId = parseOptionalPositiveInt(telegram.installationId);

  if (mode === "github") {
    if (!repo) {
      return { ok: false, error: "channels.telegram.repo is required in github mode." };
    }
    if (!issueNumber) {
      return { ok: false, error: "channels.telegram.issueNumber is required in github mode." };
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
