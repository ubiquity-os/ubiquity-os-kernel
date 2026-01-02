import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({
  // Matches `.github/.ubiquity-os.config.<ENVIRONMENT>.yml` (with `production` mapping to `.github/.ubiquity-os.config.yml`).
  ENVIRONMENT: T.String({ minLength: 1, default: "development", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
  APP_WEBHOOK_SECRET: T.String({ minLength: 1 }),
  APP_ID: T.String({ minLength: 1 }),
  APP_PRIVATE_KEY: T.String({ minLength: 1 }),
  X25519_PRIVATE_KEY: T.Optional(T.String()),
  UOS_AGENT_OWNER: T.String({ minLength: 1, default: "ubiquity-os" }),
  UOS_AGENT_REPO: T.String({ minLength: 1, default: "ubiquity-os-kernel" }),
  UOS_AGENT_WORKFLOW: T.String({ minLength: 1, default: "agent.yml" }),
  // Optional override for which branch/tag to dispatch the agent workflow from (useful for testing without updating default branch).
  UOS_AGENT_REF: T.Optional(T.String()),
  // Router model endpoint.
  UOS_AI_BASE_URL: T.String({ minLength: 1, default: "https://ai-ubq-fi.deno.dev" }),
  // Optional external KV for agent run memory (expects /kv endpoint).
  UOS_AGENT_MEMORY_URL: T.Optional(T.String({ minLength: 1 })),
  // Base64-encoded 32-byte key for AES-256-GCM at-rest encryption.
  UOS_AGENT_MEMORY_KEY: T.Optional(T.String({ minLength: 1 })),
  // Optional Supabase REST endpoint for conversation embeddings retrieval.
  UOS_VECTOR_DB_URL: T.Optional(T.String({ minLength: 1 })),
  // Optional Supabase service key for embeddings retrieval.
  UOS_VECTOR_DB_KEY: T.Optional(T.String({ minLength: 1 })),
  SUPABASE_URL: T.Optional(T.String({ minLength: 1 })),
  SUPABASE_KEY: T.Optional(T.String({ minLength: 1 })),
  SUPABASE_SERVICE_ROLE_KEY: T.Optional(T.String({ minLength: 1 })),
  SUPABASE_ANON_KEY: T.Optional(T.String({ minLength: 1 })),
  SUPABASE_PROJECT_ID: T.Optional(T.String({ minLength: 1 })),
  UOS_KERNEL_REFRESH_INTERVAL_SECONDS: T.Optional(T.String({ minLength: 1 })),
});

export type Env = Static<typeof envSchema>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      APP_ID: string;
      APP_WEBHOOK_SECRET: string;
      APP_PRIVATE_KEY: string;
      UOS_AGENT_OWNER?: string;
      UOS_AGENT_REPO?: string;
      UOS_AGENT_WORKFLOW?: string;
      UOS_AGENT_REF?: string;
      UOS_AI_BASE_URL?: string;
      UOS_AGENT_MEMORY_URL?: string;
      UOS_AGENT_MEMORY_KEY?: string;
      UOS_VECTOR_DB_URL?: string;
      UOS_VECTOR_DB_KEY?: string;
      SUPABASE_URL?: string;
      SUPABASE_KEY?: string;
      SUPABASE_SERVICE_ROLE_KEY?: string;
      SUPABASE_ANON_KEY?: string;
      SUPABASE_PROJECT_ID?: string;
      UOS_KERNEL_REFRESH_INTERVAL_SECONDS?: string;
    }
  }
}
