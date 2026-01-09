import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENTRIES = ["src/kernel.ts", "src/adapters/server.ts"];
const DEFAULT_INCLUDES = ["src"];
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "dist", "coverage"]);

const args = [...Deno.args];
const entries: string[] = [];
const includes: string[] = [];
let shouldFailOnUnused = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--entry") {
    const entry = args[i + 1];
    if (entry) entries.push(entry);
    i += 1;
    continue;
  }
  if (arg === "--include") {
    const include = args[i + 1];
    if (include) includes.push(include);
    i += 1;
    continue;
  }
  if (arg === "--fail") {
    shouldFailOnUnused = true;
  }
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}
const root = Deno.cwd();

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runDenoInfo(entry: string): Promise<Set<string>> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--sloppy-imports", entry],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    const errorText = new TextDecoder().decode(result.stderr).trim();
    const details = errorText ? `: ${errorText}` : "";
    throw new Error(`deno info failed for ${entry}${details}`);
  }

  const output = new TextDecoder().decode(result.stdout);
  const data = JSON.parse(output) as {
    roots?: string[];
    modules?: Array<{ specifier?: string }>;
  };
  const files = new Set<string>();
  for (const specifier of data.roots ?? []) {
    if (!specifier.startsWith("file://")) continue;
    const filePath = fileURLToPath(specifier);
    if (filePath.startsWith(root)) {
      files.add(normalizePath(relative(root, filePath)));
    }
  }
  for (const module of data.modules ?? []) {
    const specifier = module.specifier;
    if (!specifier || !specifier.startsWith("file://")) continue;
    const filePath = fileURLToPath(specifier);
    if (filePath.startsWith(root)) {
      files.add(normalizePath(relative(root, filePath)));
    }
  }
  return files;
}

async function collectFiles(dir: string, files: Set<string>): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await collectFiles(resolve(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile) continue;
    const filePath = resolve(dir, entry.name);
    const extension = extname(filePath).toLowerCase();
    if (![".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
      continue;
    }
    if (filePath.endsWith(".d.ts")) {
      continue;
    }
    files.add(normalizePath(relative(root, filePath)));
  }
}

const resolvedEntries = entries.length ? entries : DEFAULT_ENTRIES;
const resolvedIncludes = includes.length ? includes : DEFAULT_INCLUDES;

const entryPaths: string[] = [];
for (const entry of resolvedEntries) {
  const abs = resolve(root, entry);
  if (await pathExists(abs)) {
    entryPaths.push(abs);
  }
}

if (!entryPaths.length) {
  console.error("No valid entrypoints found. Provide --entry <path> arguments.");
  Deno.exit(1);
}

const graphFiles = new Set<string>();
for (const entry of entryPaths) {
  graphFiles.add(normalizePath(relative(root, entry)));
  const files = await runDenoInfo(entry);
  for (const file of files) {
    graphFiles.add(file);
  }
}

const candidateFiles = new Set<string>();
for (const include of resolvedIncludes) {
  const abs = resolve(root, include);
  if (!(await pathExists(abs))) continue;
  await collectFiles(abs, candidateFiles);
}

const unused = [...candidateFiles].filter((file) => !graphFiles.has(file)).sort();

if (unused.length === 0) {
  console.log(`No unused files found under ${resolvedIncludes.join(", ")}`);
  Deno.exit(0);
}

console.log("Unused files:");
for (const file of unused) {
  console.log(`- ${file}`);
}

if (shouldFailOnUnused) {
  Deno.exit(1);
}
