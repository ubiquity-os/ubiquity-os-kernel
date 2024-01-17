import { EmitterWebhookEvent } from "@octokit/webhooks";
import { GitHubEventClassName } from "./types/github-event-class-names";
import { makeGitHubEventClassName } from "./webhooks/make-github-event-class-name";

type Handlers = {
  [K in GitHubEventClassName]?: (_payload: EmitterWebhookEvent<K>["payload"]) => Promise<void>;
};

export async function handleGitHubEvent(event: EmitterWebhookEvent) {
  const gitHubEventKey = makeGitHubEventClassName(event);
  const isCorrectType = createTypeGuard(gitHubEventKey);

  if (isCorrectType(event.payload)) {
    const handler = handlers[gitHubEventKey];
    if (handler) {
      return await handler(event.payload);
    } else {
      return notImplemented(event);
    }
  } else {
    console.log(`Payload is not of type ${gitHubEventKey}`);
  }

  // const handler = handlers[gitHubEventKey];
  // if (handler) {
  //   return await handler(event.payload);
  // } else {
  //   return notImplemented(event);
  // }
}

export const handlers: Handlers = {
  "issue_comment.created": async function issueCommentCreated(payload: EmitterWebhookEvent<"issue_comment.created">["payload"]) {
    console.log(payload.comment.body);
  },
  // Add more handlers here
};

function notImplemented(event: EmitterWebhookEvent) {
  console.log(`Not implemented: ${event.name}`);
}

function createTypeGuard<T extends GitHubEventClassName>(eventName: T) {
  return (payload): payload is EmitterWebhookEvent<T>["payload"] => {
    return payload.action === eventName.split(".")[1];
  };
}
