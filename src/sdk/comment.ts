import { Context } from "./context";
import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";
import { sanitizeMetadata } from "./util";

const HEADER_NAME = "Ubiquity";

/**
 * Posts a comment on a GitHub issue if the issue exists in the context payload, embedding structured metadata to it.
 */
export async function postComment(context: Context, message: LogReturn) {
  if ("issue" in context.payload && context.payload.repository?.owner?.login) {
    const metadata = createStructuredMetadata(message.metadata?.name, message);
    await context.octokit.rest.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      body: [message.logMessage.diff, metadata].join("\n"),
    });
  } else {
    context.logger.info("Cannot post comment because issue is not found in the payload");
  }
}

function createStructuredMetadata(className: string | undefined, logReturn: LogReturn) {
  const logMessage = logReturn.logMessage;
  const metadata = logReturn.metadata;

  const jsonPretty = sanitizeMetadata(metadata);
  const stack = logReturn.metadata?.stack;
  const stackLine = (Array.isArray(stack) ? stack.join("\n") : stack)?.split("\n")[2] ?? "";
  const caller = stackLine.match(/at (\S+)/)?.[1] ?? "";
  const ubiquityMetadataHeader = `<!-- ${HEADER_NAME} - ${className} - ${caller} - ${metadata?.revision}`;

  let metadataSerialized: string;
  const metadataSerializedVisible = ["```json", jsonPretty, "```"].join("\n");
  const metadataSerializedHidden = [ubiquityMetadataHeader, jsonPretty, "-->"].join("\n");

  if (logMessage?.type === "fatal") {
    // if the log message is fatal, then we want to show the metadata
    metadataSerialized = [metadataSerializedVisible, metadataSerializedHidden].join("\n");
  } else {
    // otherwise we want to hide it
    metadataSerialized = metadataSerializedHidden;
  }

  // Add carriage returns to avoid any formatting issue
  return `\n${metadataSerialized}\n`;
}
