interface RetryOptions {
  maxRetries: number;
  onError?: (error: unknown) => void | Promise<void>;
  // Return false to stop retrying, return true to automatically delay the next retry, or a number to set the delay before the next retry
  isErrorRetryable?: (error: unknown) => boolean | number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let delay = 1000;
  let lastError: unknown = null;
  for (let i = 0; i < options.maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (options.onError) {
        await options.onError(err);
      }
      if (options.isErrorRetryable) {
        const res = options.isErrorRetryable(err);
        if (res === false) {
          throw err;
        } else if (typeof res === "number") {
          delay = res;
        }
      }
      lastError = err;
    }
    await sleep(delay);
    delay *= 2;
  }
  throw lastError;
}
