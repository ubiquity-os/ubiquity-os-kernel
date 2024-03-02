import { Type as T } from "@sinclair/typebox";
import { StaticDecode } from "@sinclair/typebox";
import { githubWebhookEvents } from "./webhook-events";

const pluginNameRegex = new RegExp("^([0-9a-zA-Z-._]+)/([0-9a-zA-Z-._]+)(?::([0-9a-zA-Z-._]+))?(?:@([0-9a-zA-Z-._]+))?$");

type GithubPlugin = {
  owner: string;
  repo: string;
  workflowId: string;
  ref?: string;
};

function githubPluginType() {
  return T.Transform(T.String())
    .Decode((value) => {
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
      return `${value.owner}/${value.repo}${value.workflowId ? ":" + value.workflowId : ""}${value.ref ? "@" + value.ref : ""}`;
    });
}

const pluginChainSchema = T.Array(
  T.Object({
    id: T.Optional(T.String()),
    plugin: githubPluginType(),
    type: T.Union([T.Literal("github")], { default: "github" }),
    with: T.Record(T.String(), T.Unknown()),
  }),
  { minItems: 1 }
);

export type PluginChain = StaticDecode<typeof pluginChainSchema>;

const handlerSchema = T.Array(
  T.Object({
    name: T.Optional(T.String()),
    description: T.Optional(T.String()),
    command: T.Optional(T.String()),
    example: T.Optional(T.String()),
    uses: pluginChainSchema,
  }),
  { default: [] }
);

export const configSchema = T.Object({
  plugins: T.Record(T.Enum(githubWebhookEvents), handlerSchema, { default: {} }),
});

export type Config = StaticDecode<typeof configSchema>;
