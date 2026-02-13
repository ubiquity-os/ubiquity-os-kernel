type EnvConfigFile = {
  envKey: string;
  flag: string;
  defaultName: string;
};

const CONFIG_FILES: EnvConfigFile[] = [
  { envKey: "UOS_GITHUB", flag: "--github", defaultName: "github.json" },
  { envKey: "UOS_AI", flag: "--ai", defaultName: "ai.json" },
  { envKey: "UOS_AGENT", flag: "--agent", defaultName: "agent.json" },
  { envKey: "UOS_AGENT_MEMORY", flag: "--agent-memory", defaultName: "agent-memory.json" },
  { envKey: "UOS_DIAGNOSTICS", flag: "--diagnostics", defaultName: "diagnostics.json" },
  { envKey: "UOS_SUPABASE", flag: "--supabase", defaultName: "supabase.json" },
  { envKey: "UOS_KERNEL", flag: "--kernel", defaultName: "kernel.json" },
  { envKey: "UOS_TELEGRAM", flag: "--telegram", defaultName: "telegram.json" },
  { envKey: "UOS_GOOGLE_DRIVE", flag: "--google-drive", defaultName: "google-drive.json" },
  { envKey: "UOS_X", flag: "--x", defaultName: "x.json" },
];

const args = Deno.args.slice();
const separatorIndex = args.indexOf("--");
const flagArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
const commandArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);

const configDir = normalizeDir(getFlagValue(flagArgs, "--config-dir") ?? ".secrets");
const envOverrides: Record<string, string> = {};

for (const configFile of CONFIG_FILES) {
  const overridePath = getFlagValue(flagArgs, configFile.flag);
  const defaultPath = joinPath(configDir, configFile.defaultName);
  const path = overridePath ?? defaultPath;
  const shouldRequire = overridePath !== undefined;
  const loaded = await loadConfigFile(path, configFile.envKey, shouldRequire);
  if (loaded) {
    envOverrides[configFile.envKey] = loaded;
  }
}

const command = commandArgs.length ? commandArgs[0] : "deno";
const commandRest = commandArgs.length ? commandArgs.slice(1) : ["task", "dev"];
const status = await new Deno.Command(command, {
  args: commandRest,
  env: {
    ...Deno.env.toObject(),
    ...envOverrides,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;

Deno.exit(status.code);

function normalizeDir(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) return "config";
  return trimmed.replace(/\/+$/g, "");
}

function joinPath(dir: string, fileName: string): string {
  if (!dir) return fileName;
  return `${dir}/${fileName}`;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === flag) {
      return args[i + 1];
    }
    if (current.startsWith(prefix)) {
      return current.slice(prefix.length);
    }
  }
  return undefined;
}

async function loadConfigFile(path: string, envKey: string, required: boolean): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) {
      if (required) {
        throw new Error(`${path} is not a file`);
      }
      return null;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && !required) {
      return null;
    }
    throw new Error(`Failed to read ${path} for ${envKey}`);
  }

  const raw = await Deno.readTextFile(path);
  if (!raw.trim()) {
    if (required) {
      throw new Error(`${path} is empty`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }

  return JSON.stringify(parsed);
}
