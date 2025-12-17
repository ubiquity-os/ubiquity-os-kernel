import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({
  // Matches `.github/.ubiquity-os.config.<ENVIRONMENT>.yml` (with `production` mapping to `.github/.ubiquity-os.config.yml`).
  ENVIRONMENT: T.String({ minLength: 1, default: "development", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
  APP_WEBHOOK_SECRET: T.String({ minLength: 1 }),
  APP_ID: T.String({ minLength: 1 }),
  APP_PRIVATE_KEY: T.String({ minLength: 1 }),
  X25519_PRIVATE_KEY: T.Optional(T.String()),
});

export type Env = Static<typeof envSchema>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      APP_ID: string;
      APP_WEBHOOK_SECRET: string;
      APP_PRIVATE_KEY: string;
    }
  }
}
