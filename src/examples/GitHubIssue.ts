import { PlaceHolder } from "./IssueCommentEventExample";

export interface GitHubIssue {
  url: "https://api.github.com/repos/pavlovcik/ubiquibot-sandbox/issues/10";
  repository_url: "https://api.github.com/repos/pavlovcik/ubiquibot-sandbox";
  labels_url: "https://api.github.com/repos/pavlovcik/ubiquibot-sandbox/issues/10/labels{/name}";
  comments_url: "https://api.github.com/repos/pavlovcik/ubiquibot-sandbox/issues/10/comments";
  events_url: "https://api.github.com/repos/pavlovcik/ubiquibot-sandbox/issues/10/events";
  html_url: "https://github.com/pavlovcik/ubiquibot-sandbox/issues/10";
  id: 2044648858;
  node_id: "I_kwDOK2eNBc553t2a";
  number: 10;
  title: "test";
  user: PlaceHolder[];
  labels: PlaceHolder[][];
  state: "open";
  locked: false;
  assignee: null;
  assignees: [];
  milestone: null;
  comments: 9;
  created_at: "2023-12-16T07:37:46Z";
  updated_at: "2023-12-16T07:59:55Z";
  closed_at: null;
  author_association: "OWNER";
  active_lock_reason: null;
  body: "test";
  reactions: PlaceHolder[];
  timeline_url: "https://api.github.com/repos/pavlovcik/ubiquibot-sandbox/issues/10/timeline";
  performed_via_github_app: null;
  state_reason: null;
}
