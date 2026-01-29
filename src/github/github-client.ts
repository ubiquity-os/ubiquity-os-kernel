import { createAppAuth } from "@octokit/auth-app";
import { customOctokit as baseOctokit } from "@ubiquity-os/plugin-sdk/octokit";

export const customOctokit = baseOctokit.defaults((instanceOptions: object) => {
  return Object.assign({}, instanceOptions, { authStrategy: createAppAuth });
});

export const tokenOctokit = baseOctokit;
