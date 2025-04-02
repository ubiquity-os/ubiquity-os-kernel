import { OpenRouterError } from "@ubiquity-os/plugin-sdk/helpers";

export function metadataBuilder(error: unknown) {
  if (typeof error === "object" && error !== null && "error" in error) {
    const err = error as OpenRouterError;
    console.log("OpenRouter error:", err.error);
    return `\n\n<!--
OpenRouter Error Details:
Type: ${err.error.code}
Message: ${err.error.message}
-->`;
  }

  const errorName = error instanceof Error ? error.name : "Unknown Error";
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error && error.stack ? error.stack.split("\n").join("\n") : "No stack trace available";

  return `\n\n<!-- 
Error Details:
Type: ${errorName}
Message: ${errorMessage}
Stack: 
${errorStack}
-->`;
}
