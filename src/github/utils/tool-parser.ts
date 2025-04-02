import { ChatCompletion, ChatCompletionTool } from "openai/resources/index.mjs";
import { jsonSchemaValidator } from "./command-validator";

export type ToolCallResult = {
  name: string;
  parameters: Record<string, unknown>;
};

export type ToolCallError = {
  error: string;
};

export function parseToolCall(response: ChatCompletion, availableCommands: ChatCompletionTool[]): ToolCallResult | ToolCallError | null {
  if (!response.choices[0]?.message.tool_calls?.length) {
    // No tool calls
    return null;
  }

  const toolCall = response.choices[0].message.tool_calls[0];
  if (!toolCall) return null;

  try {
    // Find matching command schema
    const command = availableCommands.find((cmd) => cmd.function.name === toolCall.function.name);

    // If command is not found, throw an error
    if (!command) {
      throw new Error(`Unknown command: ${toolCall.function.name}`);
    }

    const parsedParameters = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};

    // Validate parameters if command has parameter schema
    if (command.function.parameters?.type === "object" && command.function.parameters.properties) {
      try {
        console.log("Validating parameters against schema:", command.function.parameters, toolCall);
        jsonSchemaValidator(JSON.stringify(command.function.parameters), parsedParameters);
      } catch (error) {
        throw new Error(`Invalid parameters: ${error}`);
      }
    }

    return {
      name: toolCall.function.name,
      parameters: parsedParameters,
    };
  } catch (error) {
    return {
      // Catch the error build ToolCallError object
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
