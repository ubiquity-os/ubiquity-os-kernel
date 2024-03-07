import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({ WEBHOOK_SECRET: T.String({ minLength: 1 }), APP_ID: T.String({ minLength: 1 }), PRIVATE_KEY: T.String({ minLength: 1 }) });
export type Env = Static<typeof envSchema>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      APP_ID: string;
      WEBHOOK_SECRET: string;
      PRIVATE_KEY: string;
    }
  }
}
