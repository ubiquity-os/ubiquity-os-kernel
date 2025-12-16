import { emitterEventNames } from "@octokit/webhooks";
import { StaticDecode, TLiteral, Type as T, Union } from "@sinclair/typebox";

const pluginNameRegex = new RegExp("^([0-9a-zA-Z-._]+)\\/([0-9a-zA-Z-._]+)(?::([0-9a-zA-Z-._]+))?(?:@([0-9a-zA-Z-._]+(?:\\/[0-9a-zA-Z-._]+)*))?$");

export type GithubPlugin = {
  owner: string;
  repo: string;
  workflowId: string;
  ref?: string;
};

export function parsePluginIdentifier(value: string): GithubPlugin {
  const matches = value.match(pluginNameRegex);
  if (!matches) {
    throw new Error(`Invalid plugin name: ${value}`);
  }
  return {
    owner: matches[1],
    repo: matches[2],
    workflowId: matches[3] || "compute.yml",
    ref: matches[4] || undefined,
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

export type PluginConfiguration = StaticDecode<typeof configSchema>;
