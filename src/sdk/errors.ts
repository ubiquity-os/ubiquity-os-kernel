import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";
import { Context } from "./context";
import { sanitizeMetadata } from "./util";

export async function postWorkerErrorComment(context: Context, error: LogReturn) {
  if ("issue" in context.payload && context.payload.repository?.owner?.login) {
    await context.octokit.rest.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: `${error.logMessage.diff}\n<!--\n${sanitizeMetadata(error.metadata)}\n-->`,
    });
  } else {
    context.logger.info("Cannot post comment because issue is not found in the payload");
  }
}
