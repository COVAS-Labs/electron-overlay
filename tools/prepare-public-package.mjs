import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...parts] = arg.slice(2).split("=");
    return [key, parts.join("=") || "true"];
  }));
}

const args = parseArgs(process.argv.slice(2));
const ownerScope = (args["owner-scope"] ?? "covas-labs").toLowerCase();
const packageVersion = args["package-version"];
const registry = args.registry ?? "https://registry.npmjs.org";
const access = args.access ?? "public";

if (!packageVersion) throw new Error("Expected --package-version.");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(repoRoot, "packages", "electron-overlay");
const packageDir = resolve(repoRoot, "artifacts", "publish", "public", "package");
const sourceManifest = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8"));

await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
await cp(join(sourceDir, "dist"), join(packageDir, "dist"), { recursive: true, force: true });
await cp(join(sourceDir, "README.md"), join(packageDir, "README.md"), { force: true });

const publishManifest = {
  ...sourceManifest,
  name: `@${ownerScope}/electron-overlay`,
  version: packageVersion,
  optionalDependencies: {
    [`@${ownerScope}/electron-overlay-prebuilt-darwin-arm64`]: packageVersion,
    [`@${ownerScope}/electron-overlay-prebuilt-linux-x64`]: packageVersion,
    [`@${ownerScope}/electron-overlay-prebuilt-win32-x64`]: packageVersion
  },
  publishConfig: { registry, access }
};
delete publishManifest.scripts;

await writeFile(join(packageDir, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`, "utf8");
console.log(`Prepared @${ownerScope}/electron-overlay in ${packageDir}`);
