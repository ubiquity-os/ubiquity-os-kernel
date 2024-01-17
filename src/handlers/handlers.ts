import { EventPayloadMap, WebhookEventName } from "@octokit/webhooks-types";
import { emitterEventNames } from "@octokit/webhooks/dist-types/generated/webhook-names.js";


type Handlers = {
  [K in WebhookEventName]?: (event: EventPayloadMap[K]) => Promise<void>;
};

function isEventName(name: string): name is WebhookEventName {
  return emitterEventNames.includes(name as any);
}

const handlers: Handlers = {
	"issue_comment.created": async (event: EventPayloadMap["issue_comment.created"]) => {
    // Handle event here
    console.log(event);
  },
  // Add more handlers here
};

// Usage
async function handleEvent(event: { name: string; payload: EventPayloadMap[WebhookEventName] }) {
  if (isEventName(event.name)) {
    const handler = handlers[event.name];
    if (handler) {
      await handler(event.payload);
    }
  }
}

// Call handleEvent function for testing
void handleEvent({
  name: "issue_comment.created",
  payload: {
    // Fill with actual payload
  },
});
