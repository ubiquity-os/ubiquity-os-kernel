import { Octokit } from "@octokit/core";
import { requestLog } from "@octokit/plugin-request-log";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import { createAppAuth } from "@octokit/auth-app";

const defaultOptions = {
  authStrategy: createAppAuth,
};

export const customOctokit = Octokit.plugin(paginateRest, restEndpointMethods, requestLog, retry).defaults((instanceOptions: object) => {
  return Object.assign({}, defaultOptions, instanceOptions);
});
