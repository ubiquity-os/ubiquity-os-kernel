import { Webhooks } from "@octokit/webhooks";
import { augmentedOctokit } from "./github-client";
import { GitHubContext, SimplifiedContext } from "./github-context";

export type Options = {
  webhookSecret: string;
  appId: string | number;
  privateKey: string;
};

export class GitHubEventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  // public onError: Webhooks<SimplifiedContext>["onError"];

  private _webhookSecret: string;
  private _privateKey: string;
  private _appId: number;

  constructor(options: Options) {
    this._privateKey = options.privateKey;
    this._appId = Number(options.appId);
    this._webhookSecret = options.webhookSecret;

    this.webhooks = new Webhooks<SimplifiedContext>({
      secret: this._webhookSecret,
      transform: (event) => {
        let installationId: number | undefined = undefined;
        if ("installation" in event.payload) {
          installationId = event.payload.installation?.id;
        }
        const octokit = new augmentedOctokit({
          auth: {
            appId: this._appId,
            privateKey: this._privateKey,
            installationId: installationId,
          },
        });

        return new GitHubContext(event, octokit);
      },
    });

    this.on = this.webhooks.on;
    this.onAny = this.webhooks.onAny;
    // this.onError = this.webhooks.onError;
  }
}
