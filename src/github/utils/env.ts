type EnvReader = { env?: { get?: (key: string) => string | undefined } };

export function getEnvValue(key: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    const value = process.env[key];
    if (value !== undefined) return value;
  }

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
