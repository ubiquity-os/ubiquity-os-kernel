import { Webhooks } from "@octokit/webhooks";
import { Context, SimplifiedContext } from "./context";
import { customOctokit } from "./octokit";

export type Options = {
  webhookSecret: string;
  appId: string | number;
  privateKey: string;
};

export class EventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  public onError: Webhooks<SimplifiedContext>["onError"];

  private _webhookSecret: string;
  private _privateKey: string;
  private _appId: number;

  constructor(options: Options) {
    this._privateKey = options.privateKey;
    this._appId = Number(options.appId);
    /*const key = crypto.subtle
      .importKey(
        "pkcs8",
        new TextEncoder().encode(this.privateKey),
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256",
        },
        true,
        []
      )
      .then((key) => {
        crypto.subtle.exportKey("s", key).then((keydata) => {
          console.log(keydata);
        });
      });*/

    this._webhookSecret = options.webhookSecret;

    this.webhooks = new Webhooks<SimplifiedContext>({
      secret: this._webhookSecret,
      transform: (event) => {
        let installationId: number | undefined = undefined;
        if ("installation" in event.payload) {
          installationId = event.payload.installation?.id;
        }
        const octokit = new customOctokit({
          auth: {
            appId: this._appId,
            privateKey: this._privateKey,
            installationId: installationId,
          },
        });

        return new Context(event, octokit);
      },
    });

    this.on = this.webhooks.on;
    this.onAny = this.webhooks.onAny;
    this.onError = this.webhooks.onError;

    this.onAny((event) => {
      console.log(`Event ${event.name} received (id: ${event.id})`);
    });
    this.onError((error) => {
      console.error(error);
    });
  }
}
