import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { join, extname, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const _dirname = dirname(fileURLToPath(import.meta.url));
const rootSrc = resolve(_dirname, "../src");
const localSrc = join(_dirname, "src");
const copyPackageJson = join(_dirname, "package.json");
const sourcePackageJson = resolve(_dirname, "../package.json");

// Copy package.json
copyFileSync(sourcePackageJson, copyPackageJson);

function copyTsFiles(srcDir: string, destDir: string) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTsFiles(srcPath, destPath);
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
}

function fixFile(filePath: string) {
  const bakPath = filePath + ".bak";
  const original = readFileSync(filePath, "utf8");
  writeFileSync(bakPath, original, "utf8");
  let content = original;

  content = content.replace(/from "(\.[^"]*\.json)";$/gm, 'from "$1" with { type: "json" };');
  content = content.replace(/from '(\.[^']*\.json)';$/gm, "from '$1' with { type: \"json\" };");
  content = content.replace(/" with { type: "json" }" with { type: "json" }/g, '" with { type: "json" }');
  content = content.replace(/' with { type: "json" }' with { type: "json" }/g, '\' with { type: "json" }');

  content = content.replace(/from "(\.[^"]*)";$/gm, (m, p1) => (/\.json" with { type: "json" };$/.test(m) ? m : `from "${p1}.ts";`));
  content = content.replace(/from '(\.[^']*)';$/gm, (m, p1) => (/\.json' with { type: "json" };$/.test(m) ? m : `from '${p1}.ts';`));

  content = content.replace(/\.css\.ts/g, ".css");
  content = content.replace(/\.svg\.ts/g, ".svg");
  content = content.replace(/\.ts\.ts/g, ".ts");

  writeFileSync(filePath, content, "utf8");
}

function walkAndFix(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndFix(fullPath);
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      fixFile(fullPath);
    }
  }
}

// Delete all .bak files
function deleteBakFiles(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      deleteBakFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts.bak")) {
      unlinkSync(fullPath);
    }
  }
}

copyTsFiles(rootSrc, localSrc);
walkAndFix(localSrc);
deleteBakFiles(localSrc);
