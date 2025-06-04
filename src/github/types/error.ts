import { OpenRouterError } from "@ubiquity-os/plugin-sdk/helpers";

/**
 * Throwable version of OpenRouterError that extends Error
 */
export class OpenRouterResponseError extends Error {
  error: OpenRouterError["error"];

  constructor(errorData: OpenRouterError) {
    super(errorData.error.message || "OpenRouter API Error");
    this.error = errorData["error"];
    this.name = "OpenRouterResponseError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OpenRouterResponseError);
    }
  }
}
