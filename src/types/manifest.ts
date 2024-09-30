import { type Static, Type as T } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";
import { emitterEventNames } from "@octokit/webhooks";

export const runEvent = T.Union(emitterEventNames.map((o) => T.Literal(o)));

export const commandSchema = T.Object({
  description: T.String({ minLength: 1 }),
  "ubiquity:example": T.String({ minLength: 1 }),
});

export const manifestSchema = T.Object({
  name: T.String({ minLength: 1 }),
  description: T.Optional(T.String({ default: "" })),
  commands: T.Optional(T.Record(T.String(), commandSchema, { default: {} })),
  "ubiquity:listeners": T.Optional(T.Array(runEvent, { default: [] })),
  configuration: T.Optional(T.Record(T.String(), T.Any(), { default: {} })),
});

export const manifestValidator = new StandardValidator(manifestSchema);

export type Manifest = Static<typeof manifestSchema>;
