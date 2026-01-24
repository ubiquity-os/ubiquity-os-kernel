import { stub } from "jsr:@std/testing/mock";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

function toUrl(value: string | URL): string {
  return typeof value === "string" ? value : value.toString();
}

export function stubFetch(handlers: Record<string, Response | FetchHandler>) {
  return stub(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(toUrl(input), init);
    const handler = handlers[request.url];
    if (!handler) {
      throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
    }
    return typeof handler === "function" ? await handler(request) : handler;
  });
}
