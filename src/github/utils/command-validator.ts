import Ajv from "ajv";

export function jsonSchemaValidator(schema: string, parameters: Record<string, unknown>): boolean {
  try {
    // Parse the string schema to object
    const jsonSchema = JSON.parse(schema);

    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      verbose: true,
    });

    const validate = ajv.compile(jsonSchema);
    const isValid = validate(parameters);

    if (!isValid) {
      throw new Error(`Validation error: ${ajv.errorsText(validate.errors)}`);
    }

    return true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON schema: ${error.message}`);
    }
    throw error;
  }
}
