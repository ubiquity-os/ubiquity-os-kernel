import { Type as T } from "@sinclair/typebox";
import { StaticDecode } from "@sinclair/typebox";
import { GitHubEvent } from "./github-events";

enum Commands {
  Start = "start",
  Stop = "stop",
}

const handlerSchema = T.Array(
  T.Object({
    workflow: T.String(),
    settings: T.Unknown(),
  }),
  { default: [] }
);

export const configSchema = T.Object({
  handlers: T.Object({
    commands: T.Record(T.Enum(Commands), handlerSchema, { default: {} }),
    events: T.Record(T.Enum(GitHubEvent), handlerSchema, { default: {} }),
  }),
});

export type Config = StaticDecode<typeof configSchema>;
