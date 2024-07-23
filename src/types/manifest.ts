import { type Static, Type as T } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";

export const commandSchema = T.Object({
  description: T.String({ minLength: 1 }),
  "ubiquity:example": T.String({ minLength: 1 }),
});

export const manifestSchema = T.Object({
  name: T.String({ minLength: 1 }),
  description: T.String({ minLength: 1 }),
  commands: T.Record(T.String(), commandSchema),
});

export const manifestValidator = new StandardValidator(manifestSchema);

export type Manifest = Static<typeof manifestSchema>;
