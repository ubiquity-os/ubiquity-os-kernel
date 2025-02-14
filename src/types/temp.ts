import { type Static, Type as T } from "@sinclair/typebox";
import { emitterEventNames } from "@octokit/webhooks";

export const runEvent = T.Union(emitterEventNames.map((o) => T.Literal(o)));

export const exampleCommandExecutionSchema = T.Object({
  commandInvocation: T.String({ minLength: 1 }),
  githubContext: T.Optional(T.Record(T.String(), T.Any())),
  expectedToolCallResult: T.Object({
    function: T.String({ minLength: 1 }),
    parameters: T.Record(T.String(), T.Any()),
  }),
});

export const commandSchema = T.Object({
  description: T.String({ minLength: 1 }),
  "ubiquity:example": T.String({ minLength: 1 }),
  parameters: T.Optional(T.Record(T.String(), T.Any())),
  examples: T.Optional(T.Array(exampleCommandExecutionSchema, { default: [] })),
});

export const manifestSchema = T.Object({
  name: T.String({ minLength: 1 }),
  description: T.Optional(T.String({ default: "" })),
  commands: T.Optional(T.Record(T.String({ pattern: "^[A-Za-z-_]+$" }), commandSchema, { default: {} })),
  "ubiquity:listeners": T.Optional(T.Array(runEvent, { default: [] })),
  configuration: T.Optional(T.Record(T.String(), T.Any(), { default: {} })),
  skipBotEvents: T.Optional(T.Boolean({ default: true })),
});

export type Manifest = Static<typeof manifestSchema>;
