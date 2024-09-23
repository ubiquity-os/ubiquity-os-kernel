import { StaticDecode, Type } from "@sinclair/typebox";

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

const validationErrorSchema = Type.Object({
  path: Type.String(),
  message: Type.String(),
  type: Type.Number(),
  value: Type.Any(),
  schema: Type.Any(),
});

export const pluginValidationResponseSchema = Type.Object({
  message: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(validationErrorSchema)),
});

export type StateValidation = StaticDecode<typeof stateValidationSchema>;
