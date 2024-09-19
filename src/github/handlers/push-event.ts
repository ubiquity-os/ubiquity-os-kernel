import { GitHubContext } from "../github-context";
import { CONFIG_FULL_PATH } from "../utils/config";

export default async function handlePushEvent(context: GitHubContext<"push">) {
  console.log("context push", context);
  const didFileChange = context.payload.commits.some((commit) => {
    console.debug(commit);
    return commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH) || commit.removed?.includes(CONFIG_FULL_PATH);
  });

  if (didFileChange) {
    console.log("Configuration file changed, will run configuration checks.");
  }
}
