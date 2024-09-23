import { StaticDecode, Type } from "@sinclair/typebox";
import { StandardValidator } from "typebox-validators";

export const stateValidationSchema = Type.Object({
  /**
   * The YAML raw data
   */
  rawData: Type.String(),
  /**
   * Path to the YAML element in the document
   */
  path: Type.String(),
});

const validationErrorSchema = Type.Object(
  {
    path: Type.String({ default: "/" }),
    message: Type.String(),
    type: Type.Number({ default: 0 }),
    value: Type.Any({ default: undefined }),
    schema: Type.Any({ default: {} }),
  },
  { default: {} }
);

export const pluginValidationResponseSchema = Type.Object(
  {
    message: Type.Optional(Type.String()),
    errors: Type.Array(validationErrorSchema, { default: [] }),
  },
  { default: {} }
);

export const stateValidationErrorSchemaValidator = new StandardValidator(pluginValidationResponseSchema);

export type StateValidation = StaticDecode<typeof stateValidationSchema>;
