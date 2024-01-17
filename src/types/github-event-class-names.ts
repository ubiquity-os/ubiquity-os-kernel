import { emitterEventNames } from "@octokit/webhooks/dist-types/generated/webhook-names.js";
export type GitHubEventClassName = (typeof emitterEventNames)[number];
