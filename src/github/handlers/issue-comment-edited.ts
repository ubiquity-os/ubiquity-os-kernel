import { GitHubContext } from "../github-context";
import { handleAgentRunCommentEdited } from "./agent-run-comment";

export default async function issueCommentEdited(context: GitHubContext<"issue_comment.edited">) {
  await handleAgentRunCommentEdited(context, context.payload.issue.number);
}
