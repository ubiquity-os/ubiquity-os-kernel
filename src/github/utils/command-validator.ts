import { Validator } from "@cfworker/json-schema";

export function jsonSchemaValidator(schema: string, parameters: Record<string, unknown>): boolean {
  try {
    const jsonSchema = JSON.parse(schema);
    const validator = new Validator(jsonSchema);
    const result = validator.validate(parameters);

    if (!result.valid) {
      const error = result.errors[0];
      const message = error.error;
      throw new Error(`Validation error: ${message}`);
    }

    return true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON schema: ${error.message}`);
    }
    throw error;
  }
}
