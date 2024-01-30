import { Webhooks } from "@octokit/webhooks";
import { Context, SimplifiedContext } from "./context";
import { customOctokit } from "./octokit";
import { createClient } from "@supabase/supabase-js";
import { Database } from "./types/database";
import { Logs } from "ubiquibot-logger";
import { LogLevel } from "ubiquibot-logger/pretty-logs";

export type Options = {
  webhookSecret: string;
  appId: string | number;
  privateKey: string;
  supabaseUrl: string;
  supabaseKey: string;
  logRetryLimit: number;
  logLevel: LogLevel;
};

export class EventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  public onError: Webhooks<SimplifiedContext>["onError"];
  public log: Logs;

  private _webhookSecret: string;
  private _privateKey: string;
  private _appId: number;
  private _supabaseUrl: string;
  private _supabaseKey: string;
  private _logRetryLimit: number;
  private _logLevel: LogLevel;

  constructor(options: Options) {
    this._privateKey = options.privateKey;
    this._appId = Number(options.appId);
    this._webhookSecret = options.webhookSecret;
    this._supabaseKey = options.supabaseKey;
    this._supabaseUrl = options.supabaseUrl;
    this._logRetryLimit = options.logRetryLimit;
    this._logLevel = options.logLevel;

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

    const supabaseClient = createClient<Database>(this._supabaseUrl, this._supabaseKey, {
      auth: { persistSession: false },
    });

    this.log = new Logs(supabaseClient, this._logRetryLimit, this._logLevel, null);

    this.on = this.webhooks.on;
    this.onAny = this.webhooks.onAny;
    this.onError = this.webhooks.onError;

    this.onAny((event) => {
      this.log.info(`Event ${event.name} received (id: ${event.id})`, { id: event.id, name: event.name });
      console.log(`Event ${event.name} received (id: ${event.id})`);
    });
    this.onError((error) => {
      console.error(error);
    });
  }
}
