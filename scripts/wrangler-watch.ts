#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";

const WRANGLER_BIN = process.platform === "win32" ? "node_modules/.bin/wrangler.cmd" : "node_modules/.bin/wrangler";
const WATCH_DIRS = ["src"];
const WATCH_FILES = ["wrangler.toml", ".dev.vars"];
const DEBOUNCE_MS = 250;
const STOP_TIMEOUT_MS = 4000;

let child = null;
let isRestarting = false;
let restartTimer = null;
const watchers = [];

const log = (message) => {
  process.stdout.write(`[wrangler-watch] ${message}\n`);
};

const extraArgs = process.argv.slice(2);
const wranglerArgs = ["dev", "--env", "dev", "--port", "8787", ...extraArgs];

const start = () => {
  child = spawn(WRANGLER_BIN, wranglerArgs, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (isRestarting) return;
    if (signal) {
      process.exit(1);
    }
    process.exit(typeof code === "number" ? code : 0);
  });
};

const stop = () =>
  new Promise((resolveStop) => {
    if (!child) return resolveStop();
    const current = child;
    child = null;
    if (current.exitCode !== null) return resolveStop();
    const timeout = setTimeout(() => {
      try {
        current.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, STOP_TIMEOUT_MS);
    current.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    try {
      current.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolveStop();
    }
  });

const restart = async () => {
  if (isRestarting) return;
  isRestarting = true;
  log("Change detected. Restarting wrangler dev...");
  await stop();
  isRestarting = false;
  start();
};

const scheduleRestart = () => {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restart();
  }, DEBOUNCE_MS);
};

const closeWatchers = () => {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  watchers.length = 0;
};

const watchFile = (path) => {
  const abs = resolve(path);
  if (!existsSync(abs)) return;
  const watcher = watch(abs, scheduleRestart);
  watchers.push(watcher);
};

const watchDirRecursive = (path) => {
  const abs = resolve(path);
  if (!existsSync(abs)) return;
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    try {
      watchers.push(watch(current, scheduleRestart));
    } catch {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      }
    }
  }
};

for (const dir of WATCH_DIRS) {
  watchDirRecursive(dir);
}
for (const file of WATCH_FILES) {
  watchFile(file);
}

process.on("SIGINT", async () => {
  closeWatchers();
  await stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  closeWatchers();
  await stop();
  process.exit(0);
});

start();
