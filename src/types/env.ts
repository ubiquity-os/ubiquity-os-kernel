import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({ WEBHOOK_SECRET: T.String() });
export type Env = Static<typeof envSchema>;
