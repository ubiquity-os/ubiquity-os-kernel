import { Type as T, type Static } from "@sinclair/typebox";

export const envSchema = T.Object({
  // Matches `.github/.ubiquity-os.config.<ENVIRONMENT>.yml` (with `production` mapping to `.github/.ubiquity-os.config.yml`).
  ENVIRONMENT: T.String({ minLength: 1, default: "development", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
  UOS_GITHUB: T.Optional(T.String()),
  UOS_AGENT: T.Optional(T.String()),
  UOS_AI: T.Optional(T.String()),
  UOS_AGENT_MEMORY: T.Optional(T.String()),
  UOS_DIAGNOSTICS: T.Optional(T.String()),
  UOS_SUPABASE: T.Optional(T.String()),
  UOS_KERNEL: T.Optional(T.String()),
  UOS_TELEGRAM: T.Optional(T.String()),
  UOS_GOOGLE_DRIVE: T.Optional(T.String()),
  UOS_X: T.Optional(T.String()),
});

export type Env = Static<typeof envSchema>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      UOS_GITHUB?: string;
      UOS_AGENT?: string;
      UOS_AI?: string;
      UOS_AGENT_MEMORY?: string;
      UOS_DIAGNOSTICS?: string;
      UOS_SUPABASE?: string;
      UOS_KERNEL?: string;
      UOS_TELEGRAM?: string;
      UOS_GOOGLE_DRIVE?: string;
      UOS_X?: string;
    }
  }
}
