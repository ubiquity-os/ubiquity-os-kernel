import { StaticDecode, Type as T } from "@sinclair/typebox";

export const commandCallSchema = T.Union([T.Null(), T.Object({ name: T.String(), parameters: T.Unknown() })]);

export type CommandCall = StaticDecode<typeof commandCallSchema>;
