import { type Static, Type as T } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";
import { emitterEventNames } from "@octokit/webhooks";

export const runEvent = T.Union(emitterEventNames.map((o) => T.Literal(o)));

export const commandSchema = T.Object({
  description: T.String({ minLength: 1 }),
  "ubiquibot:example": T.String({ minLength: 1 }),
});

export const manifestSchema = T.Object({
  name: T.String({ minLength: 1 }),
  description: T.String({ minLength: 1 }),
  commands: T.Record(T.String(), commandSchema),
  "ubiquibot:listeners": T.Optional(T.Array(runEvent, { default: [] })),
});

export const manifestValidator = new StandardValidator(manifestSchema);

export type Manifest = Static<typeof manifestSchema>;
