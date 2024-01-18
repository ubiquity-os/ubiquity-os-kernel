import { Webhooks } from "@octokit/webhooks";
import { Context, SimplifiedContext } from "./context";

export class EventHandler {
  public webhooks: Webhooks<SimplifiedContext>;
  public on: Webhooks<SimplifiedContext>["on"];
  public onAny: Webhooks<SimplifiedContext>["onAny"];
  public onError: Webhooks<SimplifiedContext>["onError"];

  constructor(secret: string) {
    this.webhooks = new Webhooks<SimplifiedContext>({
      secret,
      transform: (event) => {
        return new Context(event);
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
