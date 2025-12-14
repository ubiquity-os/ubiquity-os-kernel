import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Plugin = { name: string; dir: string };

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
    });
  });
}

function listPlugins(libDir: string): Plugin[] {
  if (!fs.existsSync(libDir)) return [];
  return fs
    .readdirSync(libDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const dir = path.join(libDir, dirent.name);
      return { name: dirent.name, dir };
    })
    .filter((plugin) => fs.existsSync(path.join(plugin.dir, "package.json")));
}

function usageAndExit(): never {
  console.log(
    `
Usage:
  bun run setup:plugins [--all] [--force] [--skip-submodules]

Options:
  --all              Install for every plugin under lib/ (default: only missing node_modules/)
  --force            Pass --force to bun install
  --skip-submodules  Skip "git submodule update --init --recursive"
`.trim()
  );
  process.exit(0);
}

void (async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has("-h") || args.has("--help")) usageAndExit();

  const shouldInstallAll = args.has("--all");
  const shouldForceInstall = args.has("--force");
  const shouldSkipSubmodules = args.has("--skip-submodules");

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const libDir = path.join(repoRoot, "lib");

  if (!shouldSkipSubmodules && fs.existsSync(path.join(repoRoot, ".gitmodules"))) {
    console.log("Updating git submodules...");
    await run("git", ["submodule", "update", "--init", "--recursive"], repoRoot);
  }

  const plugins = listPlugins(libDir);
  if (!plugins.length) {
    console.log('No plugin packages found under "lib/".');
    process.exit(0);
  }

  const targets = shouldInstallAll ? plugins : plugins.filter((p) => !fs.existsSync(path.join(p.dir, "node_modules")));
  if (!targets.length) {
    console.log("All plugins already have node_modules/.");
    process.exit(0);
  }

  console.log(`Installing dependencies for ${targets.length} plugin(s)...`);
  for (const plugin of targets) {
    console.log(`\n==> ${plugin.name}`);
    const installArgs = ["install", "--no-save", "--ignore-scripts"];
    if (shouldForceInstall) installArgs.push("--force");
    await run("bun", installArgs, plugin.dir);
  }
})();
