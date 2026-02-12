import { GitHubContext } from "../github-context.ts";
import { ResolvedPlugin } from "../utils/plugins.ts";

const UBIQUITY_LISTENERS_KEY = "ubiquity:listeners" as const;

function extractLeadingSlashCommandName(body: string): string | null {
  const trimmed = body.trimStart();
  const match = /^\/([\w-]+)/u.exec(trimmed);
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function extractSlashCommandNameFromCommentBody(body: string): string | null {
  const direct = extractLeadingSlashCommandName(body);
  if (direct) return direct;

  const mention = /@ubiquityos\b/i.exec(body);
  if (!mention || mention.index === undefined) return null;
  const afterMention = body.slice(mention.index + mention[0].length);
  return extractLeadingSlashCommandName(afterMention);
}

type PluginManifestShape = {
  commands?: Record<string, unknown>;
  [UBIQUITY_LISTENERS_KEY]?: unknown;
};

function readManifestShape(manifest: unknown): PluginManifestShape {
  if (!manifest || typeof manifest !== "object") return {};
  return manifest as PluginManifestShape;
}

export async function filterPluginsForSlashCommandEvent({
  context,
  plugins,
  slashCommandName,
  getManifest,
}: {
  context: GitHubContext;
  plugins: ResolvedPlugin[];
  slashCommandName: string;
  getManifest: (context: GitHubContext, target: ResolvedPlugin["target"]) => Promise<unknown>;
}): Promise<ResolvedPlugin[]> {
  const filtered: ResolvedPlugin[] = [];
  for (const plugin of plugins) {
    try {
      const manifest = readManifestShape(await getManifest(context, plugin.target));
      if (!manifest.commands) {
        filtered.push(plugin);
        continue;
      }
      const commandNames = Object.keys(manifest.commands).map((name) => name.toLowerCase());
      const listeners = Array.isArray(manifest[UBIQUITY_LISTENERS_KEY])
        ? manifest[UBIQUITY_LISTENERS_KEY].filter((name): name is string => typeof name === "string").map((name) => name.toLowerCase())
        : [];
      const doesListenToEvent = listeners.includes(context.key.toLowerCase());
      if (commandNames.includes(slashCommandName)) {
        context.logger.debug({ plugin: plugin.key, command: slashCommandName }, "Skipping global dispatch for command plugin; slash handler will dispatch");
      } else if (doesListenToEvent) {
        filtered.push(plugin);
      } else {
        context.logger.debug(
          { plugin: plugin.key, command: slashCommandName },
          "Skipping global dispatch for non-matching command plugin on slash-command comment"
        );
      }
      continue;
    } catch (error) {
      context.logger.debug({ plugin: plugin.key, err: error }, "Failed to inspect plugin manifest for slash-command filtering; allowing dispatch");
    }
    filtered.push(plugin);
  }
  return filtered;
}
