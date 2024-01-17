// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
// disabled type checking in this file because the type that describes every type of github webhook payload is far too complex and slows down vscode.

import { EmitterWebhookEvent } from "@octokit/webhooks";
import { handlers } from "./handlers";
import { GitHubEventClassName } from "./types/github-event-class-names";
import { makeGitHubEventClassName } from "./webhooks/make-github-event-class-name";

export async function handleGitHubEvent(event: EmitterWebhookEvent) {
  const gitHubEventKey = makeGitHubEventClassName(event);
  const isCorrectType = createTypeGuard(gitHubEventKey);
  const payload = event.payload;

  if (isCorrectType(payload)) {
    const handler = handlers[gitHubEventKey];
    if (handler) {
      return await handler(payload);
    } else {
      return notImplemented(event);
    }
  } else {
    console.log(`Payload is not of type ${gitHubEventKey}`);
  }
}

function notImplemented(event: EmitterWebhookEvent) {
  console.log(`Not implemented: ${event.name}.${event.payload.action}`);
}

function createTypeGuard<T extends GitHubEventClassName>(eventName: T) {
  return (payload: EmitterWebhookEvent["payload"]): payload is EmitterWebhookEvent<T>["payload"] => {
    return payload.action === eventName.split(".")[1];
  };
}
