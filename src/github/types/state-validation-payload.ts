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

export const stateValidationValidator = new StandardValidator(stateValidationSchema);

export type StateValidation = StaticDecode<typeof stateValidationSchema>;
