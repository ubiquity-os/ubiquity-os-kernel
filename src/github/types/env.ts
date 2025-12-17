import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({
  // Matches `.github/.ubiquity-os.config.<ENVIRONMENT>.yml` (with `production` mapping to `.github/.ubiquity-os.config.yml`).
  ENVIRONMENT: T.String({ minLength: 1, default: "development", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
  APP_WEBHOOK_SECRET: T.String({ minLength: 1 }),
  APP_ID: T.String({ minLength: 1 }),
  APP_PRIVATE_KEY: T.String({ minLength: 1 }),
  X25519_PRIVATE_KEY: T.Optional(T.String()),
  UBQ_AGENT_OWNER: T.String({ minLength: 1, default: "ubiquity-os" }),
  UBQ_AGENT_REPO: T.String({ minLength: 1, default: "ubiquity-os-kernel" }),
  UBQ_AGENT_WORKFLOW: T.String({ minLength: 1, default: "agent.yml" }),
  // Router model endpoint (primary + fallback). The fallback avoids Cloudflare antibot pages that sometimes block CI IP ranges.
  UBQ_AI_BASE_URL: T.String({ minLength: 1, default: "https://ai.ubq.fi" }),
  UBQ_AI_FALLBACK_BASE_URL: T.String({ minLength: 1, default: "https://ai-ubq-fi.deno.dev" }),
});

export type Env = Static<typeof envSchema>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      APP_ID: string;
      APP_WEBHOOK_SECRET: string;
      APP_PRIVATE_KEY: string;
      UBQ_AGENT_OWNER?: string;
      UBQ_AGENT_REPO?: string;
      UBQ_AGENT_WORKFLOW?: string;
      UBQ_AI_BASE_URL?: string;
      UBQ_AI_FALLBACK_BASE_URL?: string;
    }
  }
}
