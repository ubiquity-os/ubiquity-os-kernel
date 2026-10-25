type EnvReader = { env?: { get?: (key: string) => string | undefined } };
type RuntimeEnv = Record<string, unknown>;

let runtimeEnv: RuntimeEnv = {};

export function setRuntimeEnv(value: unknown): void {
  runtimeEnv = value && typeof value === "object" ? (value as RuntimeEnv) : {};
}

function readRuntimeEnv(key: string): string | undefined {
  const value = runtimeEnv[key];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export function getEnvValue(key: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    const value = process.env[key];
    if (value !== undefined) return value;
  }

  const value = readRuntimeEnv(key);
  if (value !== undefined) return value;

  const deno = (globalThis as { Deno?: EnvReader }).Deno;
  if (deno?.env?.get) {
    try {
      return deno.env.get(key);
    } catch {
      return undefined;
    }
  }

  return undefined;
}
