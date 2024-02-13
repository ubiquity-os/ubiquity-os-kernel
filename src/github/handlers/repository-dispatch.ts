import { GitHubContext } from "../github-context";

export async function repositoryDispatch(event: GitHubContext<"repository_dispatch">) {
  console.log("Repository dispatch event received", event.payload);
}
