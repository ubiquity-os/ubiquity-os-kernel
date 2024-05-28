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
    // Add the new binding
    wranglerToml.kv_namespaces.push({
      binding: BINDING_NAME,
      id: namespaceId,
    });
  }

  // Write the updated toml file
  fs.writeFileSync(tomlFilePath, tomlify.toToml(wranglerToml, { space: 1 }));
}

async function main() {
  // Check if the namespace exists or create a new one
  let namespaceId: string;
  try {
    const res = execSync(`wrangler kv:namespace create ${NAMESPACE_TITLE}`).toString();
    const newId = res.match(/id = \s*"([^"]+)"/)?.[1];
    if (!newId) {
      throw new Error(`The new ID could not be found.`);
    }
    namespaceId = newId;
    console.log(`Namespace created with ID: ${namespaceId}`);
  } catch (error) {
    const listOutput = JSON.parse(execSync(`wrangler kv:namespace list`).toString()) as Namespace[];
    const existingNamespace = listOutput.find((o) => o.title === NAMESPACE_TITLE_WITH_PREFIX);
    if (!existingNamespace) {
      throw new Error(`Error creating namespace: ${error}`);
    }
    namespaceId = existingNamespace.id;
    console.log(`Namespace ${NAMESPACE_TITLE_WITH_PREFIX} already exists with ID: ${namespaceId}`);
  }

  // Update the wrangler.toml file
  updateWranglerToml(namespaceId);
}

main()
  .then(() => console.log("Successfully bound namespace."))
  .catch((e) => {
    console.error("Error checking or creating namespace:", e);
    process.exit(1);
  });
