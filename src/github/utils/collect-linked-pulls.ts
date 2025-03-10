import { Issue, User } from "@octokit/graphql-schema";
import { GitHubContext } from "../github-context";

const LINKED_ISSUES = /* GraphQL */ `
  query collectLinkedIssues($owner: String!, $repo: String!, $pull_number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pull_number) {
        closingIssuesReferences(first: 10, after: $cursor) {
          edges {
            node {
              number
              title
              url
              state
              author {
                login
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

type Task = {
  node: Pick<Issue, "number" | "title" | "url" | "state"> & {
    author: Pick<User, "login">;
  };
};

type TaskList = {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        edges: Task[];
      };
    };
  };
};

export async function collectLinkedIssue(context: GitHubContext<"issue_comment.created">) {
  try {
    const { octokit, payload } = context;
    const repo = payload.repository.name;
    const owner = payload.repository.owner.login;
    const pullNumber = payload.issue.number;
    const results = await octokit.graphql<TaskList>(LINKED_ISSUES, {
      owner,
      repo,
      pull_number: pullNumber,
    });
    const mappedIssues = results.repository.pullRequest.closingIssuesReferences.edges.map((edge) => edge.node);

    if (!mappedIssues.length) {
      console.log("No task found for PR", {
        url: payload.issue.html_url,
      });
      return null;
    }

    if (mappedIssues.length === 1) {
      return mappedIssues[0];
    }

    console.log("Multiple tasks found for PR", {
      url: payload.issue.html_url,
    });
    return mappedIssues[0];
  } catch (er) {
    console.log(er);
  }
}
