import { emitterEventNames } from "@octokit/webhooks";
import { StaticDecode, Type as T, TLiteral, Union } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";

const pluginNameRegex = new RegExp("^([0-9a-zA-Z-._]+)\\/([0-9a-zA-Z-._]+)(?::([0-9a-zA-Z-._]+))?(?:@([0-9a-zA-Z-._]+(?:\\/[0-9a-zA-Z-._]+)*))?$");

export type GithubPlugin = {
  owner: string;
  repo: string;
  workflowId: string;
  ref?: string;
};

const urlRegex = /^https?:\/\/\S+?$/;

export function isGithubPlugin(plugin: string | GithubPlugin): plugin is GithubPlugin {
  return typeof plugin !== "string";
}

export function parsePluginIdentifier(value: string): string | GithubPlugin {
  if (urlRegex.test(value)) {
    return value;
  }
  const matches = value.match(pluginNameRegex);
  if (!matches) {
    throw new Error(`Invalid plugin name: ${value}`);
  }
  const ref = matches[4] || "fix/action-entry";
  // During the `fix/action-entry` migration branch, the only supported workflow entrypoint is `action.yml`.
  const workflowId = ref === "fix/action-entry" ? "action.yml" : matches[3] || "action.yml";
  return {
    owner: matches[1],
    repo: matches[2],
    workflowId,
    ref,
  };
}

type IntoStringLiteralUnion<T> = { [K in keyof T]: T[K] extends string ? TLiteral<T[K]> : never };

export function stringLiteralUnion<T extends string[]>(values: readonly [...T]): Union<IntoStringLiteralUnion<T>> {
  const literals = values.map((value) => T.Literal(value));
  return T.Union(literals as never);
}

const emitterType = stringLiteralUnion(emitterEventNames);

const runsOnSchema = T.Array(emitterType, { default: [] });

// We accept null when a key has no following body
const pluginSettingsSchema = T.Union(
  [
    T.Null(),
    T.Object(
      {
        with: T.Record(T.String(), T.Unknown(), { default: {} }),
        runsOn: T.Optional(runsOnSchema),
        skipBotEvents: T.Optional(T.Boolean()),
      },
      { default: {} }
    ),
  ],
  { default: null }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;

export const configSchema = T.Object(
  {
    plugins: T.Record(T.String(), pluginSettingsSchema, { default: {} }),
  },
  {
    additionalProperties: true,
  }
);

export const configSchemaValidator = new StandardValidator(configSchema);

export type PluginConfiguration = StaticDecode<typeof configSchema>;
