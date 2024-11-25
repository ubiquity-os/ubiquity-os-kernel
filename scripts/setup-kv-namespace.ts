/**
 * The purpose of the script is to ensure that the KV for the worker is properly set on deployment.
 * There is currently a bug that makes the environment reset on each deploy, because of a problem with Wrangler not
 * parsing the TOML configuration properly. See https://github.com/cloudflare/workers-sdk/issues/5634
 * It seems to only work when the values are set at the root of the TOML, not withing the environments.
 * This scripts takes out the Production values for kv_namespaces and rewrites them at the root of the TOML file.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as toml from "toml";
// @ts-expect-error No typings exist for this package
import * as tomlify from "tomlify-j0.4";

const tomlFilePath = "./wrangler.toml";
const wranglerToml: WranglerConfiguration = toml.parse(fs.readFileSync(tomlFilePath, "utf-8"));

const NAMESPACE_TITLE = "kv";
const NAMESPACE_TITLE_WITH_PREFIX = `${wranglerToml.name}-${NAMESPACE_TITLE}`;
const BINDING_NAME = "PLUGIN_CHAIN_STATE";

interface Namespace {
  id: string;
  title: string;
}

interface WranglerConfiguration {
  name: string;
  env: {
    production: {
      kv_namespaces?: {
        id: string;
        binding: string;
      }[];
    };
    dev: {
      kv_namespaces?: {
        id: string;
        binding: string;
      }[];
    };
  };
  kv_namespaces: {
    id: string;
    binding: string;
  }[];
}

function updateWranglerToml(namespaceId: string) {
  // Ensure kv_namespaces array exists
  if (!wranglerToml.kv_namespaces) {
    wranglerToml.kv_namespaces = [];
  }
  if (wranglerToml.env.production.kv_namespaces) {
    wranglerToml.kv_namespaces = wranglerToml.env.production.kv_namespaces;
    delete wranglerToml.env.production.kv_namespaces;
  }
  if (wranglerToml.env.dev.kv_namespaces) {
    delete wranglerToml.env.dev.kv_namespaces;
  }

  const existingNamespace = wranglerToml.kv_namespaces.find((o) => o.binding === BINDING_NAME);
  if (existingNamespace) {
    existingNamespace.id = namespaceId;
  } else {
    wranglerToml.kv_namespaces.push({
      binding: BINDING_NAME,
      id: namespaceId,
    });
  }

  fs.writeFileSync(tomlFilePath, tomlify.toToml(wranglerToml, { space: 1 }));
}

async function main() {
  // Check if the namespace exists or create a new one
  let namespaceId: string;
  try {
    const res = execSync(`wrangler kv namespace create ${NAMESPACE_TITLE}`).toString();
    console.log(res);
    const newId = res.match(/id = \s*"([^"]+)"/)?.[1];
    if (!newId) {
      throw new Error(`The new ID could not be found.`);
    }
    namespaceId = newId;
    console.log(`Namespace created with ID: ${namespaceId}`);
  } catch (error) {
    console.error(error);
    const listOutput = JSON.parse(execSync(`wrangler kv namespace list`).toString()) as Namespace[];
    const existingNamespace = listOutput.find((o) => o.title === NAMESPACE_TITLE_WITH_PREFIX);
    if (!existingNamespace) {
      throw new Error(`Error creating namespace: ${error}`);
    }
    namespaceId = existingNamespace.id;
    console.log(`Namespace ${NAMESPACE_TITLE_WITH_PREFIX} already exists with ID: ${namespaceId}`);
  }

  updateWranglerToml(namespaceId);
}

main()
  .then(() => console.log("Successfully bound namespace."))
  .catch((e) => {
    console.error("Error checking or creating namespace:\n", e);
    process.exit(1);
  });
