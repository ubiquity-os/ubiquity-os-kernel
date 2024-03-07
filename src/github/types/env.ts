import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({ WEBHOOK_SECRET: T.String({ minLength: 1 }), APP_ID: T.String({ minLength: 1 }), PRIVATE_KEY: T.String({ minLength: 1 }) });
export type Env = Static<typeof envSchema>;
