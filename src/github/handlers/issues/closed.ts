import { GitHubContext } from "../../github-context";

export async function issuesClosed(event: GitHubContext<"issues.closed">) {
  if (event.payload.issue.state_reason === "not_planned") {
    await event.octokit.issues.createComment({
      owner: event.payload.repository.owner.login,
      repo: event.payload.repository.name,
      issue_number: event.payload.issue.number,
      body: "Skipping reward generation as the issue was closed as not planned.",
    });
  }
}
