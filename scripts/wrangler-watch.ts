#!/usr/bin/env -S deno run -A
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const WRANGLER_BIN = process.platform === "win32" ? "node_modules/.bin/wrangler.cmd" : "node_modules/.bin/wrangler";
const WATCH_DIRS = ["src"];
const WATCH_FILES = ["wrangler.toml", ".env"];
const DEBOUNCE_MS = 250;
const STOP_TIMEOUT_MS = 4000;

let child: ReturnType<typeof spawn> | null = null;
let isRestarting = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const watchers: ReturnType<typeof watch>[] = [];
let isShuttingDown = false;

function log(message: string) {
  process.stdout.write(`[wrangler-watch] ${message}\n`);
}

const extraArgs = process.argv.slice(2);
const wranglerArgs = ["dev", "--env", "dev", "--port", "8787", ...extraArgs];

function start() {
  child = spawn(WRANGLER_BIN, wranglerArgs, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (isRestarting) return;
    if (signal) {
      process.exitCode = 1;
      void shutdown("child-exit");
      return;
    }
    process.exitCode = typeof code === "number" ? code : 0;
    void shutdown("child-exit");
  });
}

function stop() {
  return new Promise<void>((resolveStop) => {
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
}

async function restart() {
  if (isRestarting) return;
  isRestarting = true;
  log("Change detected. Restarting wrangler dev...");
  await stop();
  isRestarting = false;
  start();
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restart();
  }, DEBOUNCE_MS);
}

function closeWatchers() {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  watchers.length = 0;
}

function watchFile(path: string) {
  const abs = resolve(path);
  if (!existsSync(abs)) return;
  const watcher = watch(abs, scheduleRestart);
  watchers.push(watcher);
}

function watchDirRecursive(path: string) {
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
}

for (const dir of WATCH_DIRS) {
  watchDirRecursive(dir);
}
for (const file of WATCH_FILES) {
  watchFile(file);
}

async function shutdown(signal: string, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`Received ${signal}, shutting down...`);
  closeWatchers();
  await stop();
  if (typeof process.exitCode !== "number") {
    process.exitCode = exitCode;
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT", 0);
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});

start();
