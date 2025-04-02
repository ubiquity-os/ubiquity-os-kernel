import { OpenRouterError } from "@ubiquity-os/plugin-sdk/helpers";

export function metadataBuilder(error: unknown) {
  if (typeof error === "object" && error !== null && "error" in error) {
    const err = error as OpenRouterError;
    return {
      errorName: "OpenRouterError",
      errorMessage: err.error.message,
      errorCode: err.error.code,
    };
  }

  const errorName = error instanceof Error ? error.name : "Unknown Error";
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error && error.stack ? error.stack.split("\n").join("\n") : "No stack trace available";

  return {
    errorName,
    errorMessage,
    errorStack,
  };
}
