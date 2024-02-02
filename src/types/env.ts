import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({ WEBHOOK_SECRET: T.String(), APP_ID: T.String(), PRIVATE_KEY: T.String() });
export type Env = Static<typeof envSchema>;
