import { emitterEventNames } from "@octokit/webhooks/dist-types/generated/webhook-names.js";

type EmitterEventName = (typeof emitterEventNames)[number];

import { Schema } from "@octokit/webhooks-types";

type Handlers = {
  [K in EmitterEventName]?: (payload: Schema) => Promise<void>;
};

export const handlers: Handlers = {
  "issue_comment.created": async function issueCommentCreated(payload: Schema) {
    // Now payload is of type Schema, which includes IssueCommentCreatedEvent
    console.log(payload);
  },
  // Add more handlers here
};
