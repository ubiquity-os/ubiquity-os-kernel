import PACKAGE from "./package.json";
import fs from "fs/promises";

type Exports = Record<string, { import?: string; require?: string; types: string }>;

interface PackageJson {
    name: string;
    version: string;
    description: string;
    main: string;
    types: string;
    author: string;
    license: string;
    keywords: string[];
    exports: Exports
}

export async function createCleanPackageJson(dirName: string, base = false, dirs?: string[]) {
    console.log(`Creating package.json for ${dirName}...`);
    let exports: Exports;

    if (base && dirs) {
        exports = {
            ".": {
                types: `./dist/index.d.ts`,
            },
        };

        for (const dir of dirs) {
            exports[`./${dir}`] = {
                import: `./dist/${dir}/index.mjs`,
                require: `./dist/${dir}/index.js`,
                types: `./dist/${dir}/index.d.ts`,
            };
        }
    } else {
        exports = {
            [`.`]: {
                import: `./index.mjs`,
                require: `./index.js`,
                types: `./index.d.ts`,
            },
        };
    }

    const packageJson = {
        name: PACKAGE.name,
        version: PACKAGE.version,
        description: PACKAGE.description,
        main: PACKAGE.main,
        module: PACKAGE.module,
        types: PACKAGE.typings,
        author: PACKAGE.author,
        license: PACKAGE.license,
        keywords: PACKAGE.keywords,
        exports
    };

    await writeDirPackageJson(base ? "dist" : dirName, packageJson);
}

async function writeDirPackageJson(dirName: string, packageJson: PackageJson) {
    await fs.writeFile(`./${dirName === "dist" ? "dist" : `dist/${dirName}`}/package.json`, JSON.stringify(packageJson, null, 2));
}