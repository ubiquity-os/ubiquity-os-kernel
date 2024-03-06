import { emitterEventNames, EmitterWebhookEventName as GitHubEventClassName } from "@octokit/webhooks";

export type EventName = GitHubEventClassName | "*";
export const eventNames: EventName[] = [...emitterEventNames, "*"];

type Formatted<T extends string> = T extends `${infer Prefix}.${infer Rest}` ? `${Prefix}_${Formatted<Rest>}` : T;

type GithubEventWebHookEvents = {
  [K in EventName as Formatted<Uppercase<K>>]: K;
};

type Prettify<T> = {
  [K in keyof T]: T[K];
  // this just spreads the object into a type

  // we need to use {} otherwise it'll type it as an object
  // eslint-disable-next-line @typescript-eslint/ban-types
} & {};

export const githubWebhookEvents: Prettify<GithubEventWebHookEvents> = emitterEventNames.reduce(
  (acc: GithubEventWebHookEvents, cur) => {
    const formatted = cur.replace(/\./g, "_");
    const upper = formatted.toUpperCase() as Formatted<Uppercase<GitHubEventClassName>>;
    acc[upper] = cur as Extract<GitHubEventClassName, Uppercase<GitHubEventClassName>>;
    return acc;
  },
  { "*": "*" } as GithubEventWebHookEvents
);
