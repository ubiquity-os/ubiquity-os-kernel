import { StaticDecode, TLiteral, Type as T, Union } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";
import { emitterEventNames } from "@octokit/webhooks";

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

/**
 * Transforms the string into a plugin object if the string is not an url
 */
function githubPluginType() {
  return T.Transform(T.String())
    .Decode((value) => {
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
      } as GithubPlugin;
    })
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

const pluginChainSchema = T.Array(
  T.Object({
    id: T.Optional(T.String()),
    plugin: githubPluginType(),
    with: T.Record(T.String(), T.Unknown(), { default: {} }),
    runsOn: T.Array(emitterType, { default: [] }),
  }),
  { minItems: 1, default: [] }
);

export type PluginChain = StaticDecode<typeof pluginChainSchema>;

const handlerSchema = T.Array(
  T.Object({
    name: T.Optional(T.String()),
    uses: pluginChainSchema,
    skipBotEvents: T.Boolean({ default: true }),
  }),
  { default: [] }
);

export const configSchema = T.Object(
  {
    plugins: handlerSchema,
  },
  {
    additionalProperties: true,
  }
);

export const configSchemaValidator = new StandardValidator(configSchema);

export type PluginConfiguration = StaticDecode<typeof configSchema>;
