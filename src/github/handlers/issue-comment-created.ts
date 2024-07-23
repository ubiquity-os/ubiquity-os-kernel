import { GitHubContext } from "../github-context";
import { postHelpCommand } from "./help-command";

export default async function issueCommentCreated(context: GitHubContext<"issue_comment.created">) {
  const body = context.payload.comment.body.trim();
  if (/^\/help$/.test(body)) {
    await postHelpCommand(context);
  }
}
