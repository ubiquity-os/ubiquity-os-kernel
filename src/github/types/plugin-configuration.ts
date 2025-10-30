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
  return {
    owner: matches[1],
    repo: matches[2],
    workflowId: matches[3] || "compute.yml",
    ref: matches[4] || undefined,
  };
}

function githubPluginType() {
  return T.Transform(T.String())
    .Decode(parsePluginIdentifier)
    .Encode((value) => {
      if (typeof value === "string") {
        return value;
      }
      return `${value.owner}/${value.repo}${value.workflowId ? ":" + value.workflowId : ""}${value.ref ? "@" + value.ref : ""}`;
    });
}

type IntoStringLiteralUnion<T> = { [K in keyof T]: T[K] extends string ? TLiteral<T[K]> : never };

export function stringLiteralUnion<T extends string[]>(values: readonly [...T]): Union<IntoStringLiteralUnion<T>> {
  const literals = values.map((value) => T.Literal(value));
  return T.Union(literals as never);
}

const emitterType = stringLiteralUnion(emitterEventNames);

const runsOnSchema = T.Transform(T.Union([T.Array(emitterType), emitterType, T.Null(), T.Undefined()], { default: [] }))
  .Decode((value) => {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string") {
      return [value];
    }
    return [];
  })
  .Encode((value) => value);

const pluginInvocationSchema = T.Object({
  id: T.Optional(T.String()),
  plugin: githubPluginType(),
  with: T.Record(T.String(), T.Unknown(), { default: {} }),
  runsOn: T.Optional(runsOnSchema),
  skipBotEvents: T.Optional(T.Boolean()),
});

export const pluginChainSchema = T.Array(pluginInvocationSchema, { minItems: 1, default: [] });

export type PluginChain = StaticDecode<typeof pluginChainSchema>;

const pluginSettingsSchema = T.Object({
  with: T.Record(T.String(), T.Unknown(), { default: {} }),
  runsOn: T.Optional(runsOnSchema),
  skipBotEvents: T.Optional(T.Boolean()),
});

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
