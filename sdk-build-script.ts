import PACKAGE from "./package.json";
import fs from "fs/promises";

type Exports = Record<string, { import?: string; require?: string; types: string }>;

interface PackageJson {
  name: string;
  version: string;
  description: string;
  main: string;
  module: string;
  types: string;
  author: string;
  license: string;
  keywords: string[];
  exports: Exports;
}

export async function createCleanPackageJson(dirName: string, base = false, dirs?: string[]) {
  console.log(`Creating package.json for ${!dirName ? "index" : dirName}...`);
  let exports: Exports;

  const packageJson = {
    name: PACKAGE.name,
    version: PACKAGE.version,
    description: PACKAGE.description,
    main: "./",
    module: "./",
    types: "./",
    author: PACKAGE.author,
    license: PACKAGE.license,
    keywords: PACKAGE.keywords,
    exports: {} as Exports,
  } as unknown as PackageJson;

  if (base && dirs) {
    exports = {
      ".": {
        types: `./sdk/index.d.ts`,
        import: `./sdk/index.mjs`,
        require: `./sdk/index.js`,
      },
    };

    for (const dir of dirs) {
      exports[`./${dir}`] = {
        import: `./${dir}/index.mjs`,
        require: `./${dir}/index.js`,
        types: `./${dir}/index.d.ts`,
      };
    }

    packageJson.exports = exports;
    packageJson.types = `./sdk/index.d.ts`;
    packageJson.main = `./sdk/index.js`;
    packageJson.module = `./sdk/index.mjs`;

    await writeDirPackageJson("dist", packageJson);
  } else {
    exports = {
      [`.`]: {
        import: `./index.mjs`,
        require: `./index.js`,
        types: `./index.d.ts`,
      },
    };

    packageJson.exports = exports;
    packageJson.types = `./index.d.ts`;
    packageJson.main = `./index.js`;
    packageJson.module = `./index.mjs`;

    await writeDirPackageJson(dirName, packageJson);
  }
}

async function writeDirPackageJson(dirName: string, packageJson: PackageJson) {
  const path = dirName === "dist" ? "./dist/package.json" : `./dist/${dirName}/package.json`;
  await fs.writeFile(path, JSON.stringify(packageJson, null, 2));
}
