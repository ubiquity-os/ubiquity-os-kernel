import { GitHubComment } from "./GitHubComment";
import { GitHubInstallation } from "./GitHubInstallation";
import { GitHubIssue } from "./GitHubIssue";
import { GitHubRepository } from "./GitHubRepository";
import { GitHubSender } from "./GitHubSender";

export interface IssueCommentEventExample {
  id: "19a60520-9be9-11ee-9c05-47ece081390b";
  name: "issue_comment";
  payload: {
    action: "created";
    issue: GitHubIssue;
    comment: GitHubComment;
    repository: GitHubRepository;
    sender: GitHubSender;
    installation: GitHubInstallation;
  };
}

export interface PlaceHolder {}
