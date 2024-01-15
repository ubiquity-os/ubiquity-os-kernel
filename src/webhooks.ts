import Ajv from "ajv";
import addFormats from "ajv-formats";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import GithubEventValidationFunc from "./github-event-validator.mjs";

const ajv = new Ajv({ strict: true });
addFormats(ajv);
ajv.addKeyword("tsAdditionalProperties");

export async function handleEvent(event: EmitterWebhookEvent) {
  console.log(event.payload);
  const validateGithubEvent = GithubEventValidationFunc;
  const isValid = validateGithubEvent(event.payload);
  if (!isValid) {
    console.error("Invalid event payload", validateGithubEvent.errors);
    return;
  }
  console.log(event.name);
}
