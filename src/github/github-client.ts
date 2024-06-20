import { Octokit } from "@octokit/core";
import { RequestOptions } from "@octokit/types";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { createAppAuth } from "@octokit/auth-app";

const defaultOptions = {
  authStrategy: createAppAuth,
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

function requestLogging(octokit: Octokit) {
  octokit.hook.error("request", (error, options) => {
    if ("status" in error) {
      const { method, url, body } = octokit.request.endpoint.parse(options);
      const msg = `GitHub request: ${method} ${url} - ${error.status}`;

      // @ts-expect-error log.debug is a pino log method and accepts a fields object
      octokit.log.debug(body || {}, msg);
    }

    throw error;
  });

  octokit.hook.after("request", (result, options) => {
    const { method, url, body } = octokit.request.endpoint.parse(options);
    const msg = `GitHub request: ${method} ${url} - ${result.status}`;

    // @ts-expect-error log.debug is a pino log method and accepts a fields object
    octokit.log.debug(body || {}, msg);
  });
}

export const customOctokit = Octokit.plugin(throttling, retry, paginateRest, restEndpointMethods, requestLogging).defaults((instanceOptions: object) => {
  return Object.assign({}, defaultOptions, instanceOptions);
});
