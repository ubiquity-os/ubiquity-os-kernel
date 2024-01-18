import { Context } from "../../context";

export async function handleIssueCommentCreated(event: Context<"issue_comment.created">) {
  console.log(event);
}
