import { confirm, input, select } from "@inquirer/prompts";
import { exec, spawn } from "child_process";
import { parse } from "dotenv";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import ora from "ora";
import path from "path";
import toml from "toml";
import { fileURLToPath } from "url";

interface WranglerConfiguration {
  env?: Record<string, unknown>;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRANGLER_PATH = path.resolve(SCRIPT_DIR, "..", "node_modules/.bin/wrangler");
const WRANGLER_TOML_PATH = path.resolve(SCRIPT_DIR, "..", "wrangler.toml");

function checkIfWranglerInstalled() {
  return new Promise((resolve) => {
    exec(`${WRANGLER_PATH} --version`, (err, stdout, stderr) => {
      if (err || stderr) {
        resolve(false);
      }
      resolve(true);
    });
  });
}

function checkIfWranglerIsLoggedIn() {
  return new Promise((resolve, reject) => {
    exec(`${WRANGLER_PATH} whoami`, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      }
      if (stdout.includes("You are not authenticated") || stderr.includes("You are not authenticated")) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function wranglerLogin() {
  return new Promise<void>((resolve, reject) => {
    const loginProcess = spawn(WRANGLER_PATH, ["login"], { stdio: "inherit" });

    loginProcess.on("close", (code) => {
      if (code !== 0) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

function wranglerBulkSecrets(env: string | null, filePath: string) {
  return new Promise<void>((resolve, reject) => {
    const args = env ? ["--env", env] : [];
    const process = spawn(WRANGLER_PATH, ["secret", "bulk", filePath, ...args], { stdio: "inherit" });

    process.on("close", (code) => {
      if (code !== 0) {
        reject();
      } else {
        resolve();
      }
    });
    process.on("error", (err) => {
      reject(err);
    });
  });
}

function wranglerDeploy(env: string | null) {
  return new Promise<void>((resolve, reject) => {
    const args = env ? ["--env", env] : [];
    const process = spawn(WRANGLER_PATH, ["deploy", ...args], { stdio: "inherit" });

    process.on("close", (code) => {
      if (code !== 0) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

void (async () => {
  const spinner = ora("Checking if Wrangler is installed").start();
  const wranglerInstalled = await checkIfWranglerInstalled();
  if (!wranglerInstalled) {
    spinner.fail("Wrangler is not installed. Please install it before running this script");
    process.exit(1);
  } else {
    spinner.succeed("Wrangler is installed");
  }

  spinner.start("Checking if Wrangler is logged in");
  const wranglerLoggedIn = await checkIfWranglerIsLoggedIn();
  if (!wranglerLoggedIn) {
    spinner.warn("Wrangler is not logged in. Please login to Wrangler");
    await wranglerLogin();
    spinner.succeed("Wrangler is now logged in");
  } else {
    spinner.succeed("Wrangler is logged in");
  }

  spinner.start("Searching environments in wrangler.toml");
  const wranglerToml: WranglerConfiguration = toml.parse(readFileSync(WRANGLER_TOML_PATH, "utf-8"));
  if (!wranglerToml) {
    spinner.fail("Error parsing wrangler.toml");
    process.exit(1);
  }
  const envs = Object.keys(wranglerToml.env ?? {});
  let selectedEnv: string | null = null;
  if (envs.length === 0) {
    spinner.warn("No environments found, choosing default environment");
  } else if (envs.length === 1) {
    spinner.warn(`Only one environment found: ${envs[0]}`);
    selectedEnv = envs[0];
  } else if (envs.length > 1) {
    spinner.stop();
    selectedEnv = await select({
      message: "Select the environment to deploy to:",
      choices: envs,
    });
  }

  const willSetSecrets = await confirm({
    message: "Do you want to set secrets?",
    default: true,
  });
  if (willSetSecrets) {
    const envFile = await input({
      message: "Enter the name of the env file to use:",
      default: `.${selectedEnv}.vars`,
    });
    const spinner = ora("Setting secrets").render();
    try {
      const env = readFileSync(path.resolve(SCRIPT_DIR, "..", envFile), { encoding: "utf-8" });
      const parsedEnv = parse(env);
      if (parsedEnv) {
        const tmpPath = path.resolve(SCRIPT_DIR, "..", `${envFile}.json.tmp`);
        writeFileSync(tmpPath, JSON.stringify(parsedEnv));
        await wranglerBulkSecrets(selectedEnv, tmpPath);
        unlinkSync(tmpPath); // deletes the temporary file
        spinner.succeed("Secrets set successfully");
      }
    } catch (err) {
      spinner.fail(`Error setting secrets: ${err}`);
      process.exit(1);
    }
  }

  spinner.start("Deploying to Cloudflare Workers").stopAndPersist();
  try {
    await wranglerDeploy(selectedEnv);
    spinner.succeed("Deployed successfully");
  } catch (err) {
    spinner.fail(`Error deploying: ${err}`);
    process.exit(1);
  }
})();
