import { Validator } from "jsonschema";

export function jsonSchemaValidator(schema: string, parameters: Record<string, unknown>): boolean {
  try {
    const jsonSchema = JSON.parse(schema);
    const validator = new Validator();
    const result = validator.validate(parameters, jsonSchema);

    if (!result.valid) {
      const error = result.errors[0];
      let message = error.message;
      const property = error.property.replace("instance.", "");

      // Format error messages consistently
      if (error.name === "required") {
        message = `Missing required property '${error.argument}'`;
      } else if (error.name === "additionalProperties") {
        message = `Additional property '${error.argument}' is not allowed`;
      } else if (property) {
        message = `Property '${property}' ${error.message}`;
      }

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
