import { emitterEventNames } from "@octokit/webhooks";
import { Kind, StaticDecode, Type as T, TLiteral, Union, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ValueError } from "@sinclair/typebox/value";

const pluginNameRegex = new RegExp("^([0-9a-zA-Z-._]+)\\/([0-9a-zA-Z-._]+)(?::([0-9a-zA-Z-._]+))?(?:@([0-9a-zA-Z-._]+(?:\\/[0-9a-zA-Z-._]+)*))?$");

export type GithubPlugin = {
  owner: string;
  repo: string;
  workflowId: string;
  ref?: string;
};

const urlRegex = /^https?:\/\/\S+?$/;

const TYPEBOX_REQUIRED_ERROR_MESSAGE = "Expected required property";
const UNKNOWN_TYPE_NAMES = new Set(["Any", "Unknown"]);

function adjustErrorMessage(error: ValueError) {
  const schema = error.schema as TSchema & { errorMessage?: string };
  if (schema.errorMessage !== undefined) {
    error.message = schema.errorMessage;
  }
  return error;
}

function createErrorsIterable(errors: Iterable<ValueError>): Iterable<ValueError> {
  return {
    [Symbol.iterator]: function* () {
      const iterator = errors[Symbol.iterator]();
      let result = iterator.next();
      let customErrorPath = "???";

      while (!result.done) {
        const error = result.value;
        const standardMessage = error.message;

        if (error.path !== customErrorPath) {
          adjustErrorMessage(error);
          const schemaRecord = error.schema as unknown as Record<PropertyKey, unknown>;
          if (error.message !== standardMessage) {
            customErrorPath = error.path;
            yield error;
          } else if (error.message !== TYPEBOX_REQUIRED_ERROR_MESSAGE || UNKNOWN_TYPE_NAMES.has(schemaRecord[Kind] as string)) {
            yield error;
          }
        }

        result = iterator.next();
      }
    },
  };
}

function createSchemaValidator(schema: TSchema) {
  return {
    testReturningErrors(value: Readonly<unknown>): Iterable<ValueError> | null {
      if (Value.Check(schema, value)) {
        return null;
      }
      return createErrorsIterable(Value.Errors(schema, value));
    },
  };
}

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

type IntoStringLiteralUnion<T> = { [K in keyof T]: T[K] extends string ? TLiteral<T[K]> : never };

export function stringLiteralUnion<T extends string[]>(values: readonly [...T]): Union<IntoStringLiteralUnion<T>> {
  const literals = values.map((value) => T.Literal(value));
  return T.Union(literals as never);
}

const emitterType = stringLiteralUnion(emitterEventNames);

const runsOnSchema = T.Array(emitterType, { default: [] });

// We accept null when a key has no following body
export const pluginSettingsObjectSchema = T.Object(
  {
    with: T.Record(T.String(), T.Unknown(), { default: {} }),
    runsOn: T.Optional(runsOnSchema),
    skipBotEvents: T.Optional(T.Boolean()),
  },
  { default: {} }
);
export const pluginSettingsSchema = T.Union([T.Null(), pluginSettingsObjectSchema], { default: null });

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;

export const configSchema = T.Object(
  {
    imports: T.Optional(T.Array(T.String(), { default: [] })),
    plugins: T.Record(T.String(), pluginSettingsSchema, { default: {} }),
  },
  {
    additionalProperties: true,
  }
);

export const configSchemaValidator = createSchemaValidator(configSchema);

export type PluginConfiguration = StaticDecode<typeof configSchema>;
