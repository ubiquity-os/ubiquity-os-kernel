import { GitHubContext } from "../../github-context";

export async function issueCommentCreated(event: GitHubContext<"issue_comment.created">) {
  if (event.payload.comment.user.type === "Bot") {
    console.log("Skipping bot comment");
    return null;
  }

  await event.octokit.issues.createComment({
    owner: event.payload.repository.owner.login,
    repo: event.payload.repository.name,
    issue_number: event.payload.issue.number,
    body: "Hello from the worker!",
  });
}
