import { Octokit } from "@octokit/core";
import { requestLog } from "@octokit/plugin-request-log";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestOptions } from "@octokit/types";
import { createAppAuth } from "@octokit/auth-app";

const sharedOptions = {
  throttle: {
    onAbuseLimit: (retryAfter: number, options: RequestOptions, octokit: Octokit) => {
      octokit.log.warn(`Abuse limit hit with "${options.method} ${options.url}", retrying in ${retryAfter} seconds.`);
      return true;
    },
    onRateLimit: (retryAfter: number, options: RequestOptions, octokit: Octokit) => {
      octokit.log.warn(`Rate limit hit with "${options.method} ${options.url}", retrying in ${retryAfter} seconds.`);
      return true;
    },
    onSecondaryRateLimit: (retryAfter: number, options: RequestOptions, octokit: Octokit) => {
      octokit.log.warn(`Secondary rate limit hit with "${options.method} ${options.url}", retrying in ${retryAfter} seconds.`);
      return true;
    },
  },
};

const octokitBase = Octokit.plugin(throttling, retry, paginateRest, restEndpointMethods, requestLog);

export const customOctokit = octokitBase.defaults((instanceOptions: object) => {
  return Object.assign({}, sharedOptions, { authStrategy: createAppAuth }, instanceOptions);
});

export const tokenOctokit = octokitBase.defaults((instanceOptions: object) => {
  return Object.assign({}, sharedOptions, instanceOptions);
});
