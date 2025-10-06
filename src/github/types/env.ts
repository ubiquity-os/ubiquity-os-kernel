import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({
  ENVIRONMENT: T.Union([T.Literal("production"), T.Literal("development")], { default: "development" }),
  APP_WEBHOOK_SECRET: T.String({ minLength: 1 }),
  APP_ID: T.String({ minLength: 1 }),
  APP_PRIVATE_KEY: T.String({ minLength: 1 }),
  OPENROUTER_API_KEY: T.String({ minLength: 1 }),
  OPENROUTER_MODEL: T.String({ minLength: 1, default: "deepseek/deepseek-chat-v3-0324:free" }),
  OPENROUTER_BASE_URL: T.String({ minLength: 1, default: "https://openrouter.ai/api/v1" }),
  X25519_PRIVATE_KEY: T.Optional(T.String()),
  KV_URL: T.String({ minLength: 1 }),
});

export type Env = Static<typeof envSchema> & {
  PLUGIN_CHAIN_STATE: KVNamespace;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      APP_ID: string;
      APP_WEBHOOK_SECRET: string;
      APP_PRIVATE_KEY: string;
      OPENROUTER_API_KEY: string;
      OPENROUTER_MODEL: string;
      OPENROUTER_BASE_URL: string;
    }
  }
}
