import yaml from "js-yaml";
import { GitHubContext } from "./github-context";

export type UbiquiBotConfig = {
  keys: {
    evmPrivateEncrypted: string;
    openAi: string;
  };
  features: {
    assistivePricing: boolean;
    publicAccessControl: unknown;
  };
  payments: {
    evmNetworkId: 1 | 100;
    basePriceMultiplier: number;
    issueCreatorMultiplier: number;
    maxPermitPrice: number;
  };
  timers: {
    reviewDelayTolerance: string;
    taskStaleTimeoutDuration: string;
    taskFollowUpDuration: string;
    taskDisqualifyDuration: string;
  };
  miscellaneous: {
    promotionComment: string;
    maxConcurrentTasks: number;
    registerWalletWithVerification: boolean;
  };
  disabledCommands: string[];
  incentives: { comment: unknown };
  labels: { time: string[]; priority: string[] };
};

export async function getUbiquiBotConfig(event: GitHubContext<"issue_comment.created">): Promise<UbiquiBotConfig> {
  const responses = {
    repositoryConfig: null as UbiquiBotConfig | null,
    organizationConfig: null as UbiquiBotConfig | null,
  };

  try {
    responses.repositoryConfig = await fetchConfig(event, event.payload.repository.name);
  } catch (error) {
    console.error(error);
  }

  try {
    responses.organizationConfig = await fetchConfig(event, `.ubiquibot-config`);
  } catch (error) {
    console.error(error);
  }

  // Merge the two configs
  return {
    ...(responses.organizationConfig || {}),
    ...(responses.repositoryConfig || {}),
  } as UbiquiBotConfig;
}

async function fetchConfig(event: GitHubContext<"issue_comment.created">, repo: string): Promise<UbiquiBotConfig | null> {
  const response = await event.octokit.rest.repos.getContent({
    owner: event.payload.repository.owner.login,
    repo,
    path: ".github/ubiquibot-config.yml",
  });

  // Check if the response data is a file and has a content property
  if ("content" in response.data && typeof response.data.content === "string") {
    // Convert the content from Base64 to string and parse the YAML content
    const content = atob(response.data.content).toString();
    return yaml.load(content) as UbiquiBotConfig;
  } else {
    return null;
    // throw new Error("Expected file content, but got something else");
  }
}
