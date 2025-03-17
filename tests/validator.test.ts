import { describe, expect, it } from "@jest/globals";
import { jsonSchemaValidator } from "../src/github/utils/command-validator";
import { parseToolCall, ToolCallError } from "../src/github/utils/tool-parser";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { ChatCompletion } from "openai/resources";

const ERROR_MESSAGE = "Validation error";

describe("Command parameter validation", () => {
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

  it("should fail tool parsing with invalid parameters", () => {
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

  it("should handle invalid schema", () => {
    expect(() => {
      jsonSchemaValidator("invalid json", {});
    }).toThrow("Invalid JSON schema");
  });
});
