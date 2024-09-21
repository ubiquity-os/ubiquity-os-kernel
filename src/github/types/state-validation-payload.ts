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

export type StateValidation = StaticDecode<typeof stateValidationSchema>;
