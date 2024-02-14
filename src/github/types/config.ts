import { Type as T } from "@sinclair/typebox";
import { StaticDecode } from "@sinclair/typebox";
import { githubWebhookEvents } from "./webhook-events";

enum Commands {
  Start = "start",
  Stop = "stop",
}

const handlerSchema = T.Array(
  T.Object({
    workflow: T.Object({
      owner: T.String(),
      repository: T.String(),
      workflowId: T.String(),
      branch: T.Optional(T.String()),
    }),
    settings: T.Optional(T.Unknown()),
  }),
  { default: [] }
);

export const configSchema = T.Object({
  handlers: T.Object(
    {
      commands: T.Record(T.Enum(Commands), handlerSchema, { default: {} }),
      events: T.Record(T.Enum(githubWebhookEvents), handlerSchema, { default: {} }),
    },
    { default: {} }
  ),
});

export type Config = StaticDecode<typeof configSchema>;
