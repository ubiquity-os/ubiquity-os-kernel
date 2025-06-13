import { describe, expect, it } from "@jest/globals";
import { jsonSchemaValidator } from "../src/github/utils/command-validator";
import { parseToolCall, ToolCallError } from "../src/github/utils/tool-parser";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { ChatCompletion } from "openai/resources";

const ERROR_MESSAGE = "Validation error";
const SCHEMA_ERROR = (prop: string) => `Validation error: Property "${prop}" does not match schema.`;

describe("Command parameter validation", () => {
  describe("Basic validations", () => {
    const schema = {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask",
        },
      },
      required: ["question"],
      additionalProperties: false,
    };

    it("should fail validation when required property is missing", () => {
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {});
      }).toThrow(ERROR_MESSAGE);
    });

    it("should fail validation when property type is wrong", () => {
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          question: 123,
        });
      }).toThrow(ERROR_MESSAGE);
    });

    it("should fail validation when additional property is present", () => {
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          question: "What is this?",
          extra: "not allowed",
        });
      }).toThrow(ERROR_MESSAGE);
    });

    it("should handle invalid schema", () => {
      expect(() => {
        jsonSchemaValidator("invalid json", {});
      }).toThrow("Invalid JSON schema");
    });
  });

  describe("Number validations", () => {
    const schema = {
      type: "object",
      properties: {
        age: {
          type: "number",
          minimum: 0,
          maximum: 120,
          multipleOf: 1,
        },
        score: {
          type: "number",
          exclusiveMinimum: 0,
          exclusiveMaximum: 100,
        },
      },
    };

    it("should validate number constraints", () => {
      // Valid values
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { age: 25, score: 75 });
      }).not.toThrow();

      // Below minimum
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { age: -1 });
      }).toThrow(SCHEMA_ERROR("age"));

      // Above maximum
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { age: 121 });
      }).toThrow(SCHEMA_ERROR("age"));

      // Not multiple of
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { age: 25.5 });
      }).toThrow(SCHEMA_ERROR("age"));

      // Equal to exclusive minimum
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { score: 0 });
      }).toThrow(SCHEMA_ERROR("score"));

      // Equal to exclusive maximum
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { score: 100 });
      }).toThrow(SCHEMA_ERROR("score"));
    });
  });

  describe("String validations", () => {
    const schema = {
      type: "object",
      properties: {
        username: {
          type: "string",
          minLength: 3,
          maxLength: 20,
          pattern: "^[a-zA-Z0-9_]+$",
        },
      },
    };

    it("should validate string constraints", () => {
      // Valid value
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { username: "user123" });
      }).not.toThrow();

      // Too short
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { username: "ab" });
      }).toThrow(SCHEMA_ERROR("username"));

      // Too long
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { username: "a".repeat(21) });
      }).toThrow(SCHEMA_ERROR("username"));

      // Invalid pattern
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { username: "user@123" });
      }).toThrow(SCHEMA_ERROR("username"));
    });
  });

  describe("Array validations", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 2,
          },
        },
      },
    };

    it("should validate array constraints", () => {
      // Valid array
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { tags: ["one", "two"] });
      }).not.toThrow();

      // Empty array
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { tags: [] });
      }).toThrow(SCHEMA_ERROR("tags"));

      // Too many items
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { tags: ["1", "2", "3", "4"] });
      }).toThrow(SCHEMA_ERROR("tags"));

      // Duplicate items
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { tags: ["one", "one"] });
      }).toThrow(SCHEMA_ERROR("tags"));

      // Invalid item length
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), { tags: ["one", "a"] });
      }).toThrow(SCHEMA_ERROR("tags"));
    });
  });

  describe("Nested object validations", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            address: {
              type: "object",
              properties: {
                city: { type: "string" },
                zipcode: { type: "string", pattern: "^\\d{5}$" },
              },
            },
          },
        },
      },
    };

    it("should validate nested objects", () => {
      // Valid nested object
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          user: {
            name: "John",
            address: {
              city: "New York",
              zipcode: "12345",
            },
          },
        });
      }).not.toThrow();

      // Missing required nested property
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          user: {
            address: { city: "New York" },
          },
        });
      }).toThrow(SCHEMA_ERROR("user"));

      // Invalid nested property
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          user: {
            name: "John",
            address: {
              city: "New York",
              zipcode: "123",
            },
          },
        });
      }).toThrow(SCHEMA_ERROR("user"));
    });
  });

  describe("Enum validations", () => {
    const schema = {
      type: "object",
      properties: {
        color: {
          enum: ["red", "green", "blue"],
        },
        size: {
          type: "number",
          enum: [1, 2, 3],
        },
      },
    };

    it("should validate enum values", () => {
      // Valid enum values
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          color: "red",
          size: 2,
        });
      }).not.toThrow();

      // Invalid string enum
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          color: "yellow",
        });
      }).toThrow(SCHEMA_ERROR("color"));

      // Invalid number enum
      expect(() => {
        jsonSchemaValidator(JSON.stringify(schema), {
          size: 4,
        });
      }).toThrow(SCHEMA_ERROR("size"));
    });
  });

  it("should fail tool parsing with invalid parameters", () => {
    const schema = {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask",
        },
      },
      required: ["question"],
      additionalProperties: false,
    };

    const askCommand: ChatCompletionTool = {
      type: "function",
      function: {
        name: "ask",
        description: "Ask a question about the repository",
        parameters: schema,
      },
    };

    const mockCompletion = {
      id: "test",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "ask",
                  arguments: JSON.stringify({
                    wrong_field: "invalid",
                  }),
                },
                id: "test",
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
    } as unknown as ChatCompletion;

    const result = parseToolCall(mockCompletion, [askCommand]);
    expect(result).toHaveProperty("error");
    expect((result as ToolCallError).error).toMatch(/Validation error/);
  });
});
