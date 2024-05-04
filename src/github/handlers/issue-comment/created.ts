import { GitHubContext } from "../../github-context";

export async function issueCommentCreated(event: GitHubContext<"issue_comment.created">) {
  if (event.payload.comment.user.type === "Bot") {
    console.log("Skipping bot comment");
    return null;
  }
}
