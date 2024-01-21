import { Context } from "../../context";

export async function handleIssueCommentCreated(event: Context<"issue_comment.created">) {
  console.log(event);

  await event.octokit.issues.createComment({
    owner: event.payload.repository.owner.login,
    repo: event.payload.repository.name,
    issue_number: event.payload.issue.number,
    body: "Hello from the worker!",
  });
}
