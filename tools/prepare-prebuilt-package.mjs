import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
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
const platform = process.platform;
const arch = process.arch;
const packageName = `@${ownerScope}/electron-overlay-prebuilt-${platform}-${arch}`;
const packageDir = resolve(repoRoot, "artifacts", "publish", `prebuilt-${platform}-${arch}`, "package");
const addonSource = resolve(repoRoot, "packages", "native-addon", "build", "Release", "x11_overlay.node");

await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
await copyFile(addonSource, join(packageDir, "x11_overlay.node"));
await writeFile(join(packageDir, "index.js"), `module.exports = require("./x11_overlay.node");\n`, "utf8");
await writeFile(join(packageDir, "metadata.json"), `${JSON.stringify({
  packageName,
  packageVersion,
  runtime: "electron",
  platform,
  arch
}, null, 2)}\n`, "utf8");
await writeFile(join(packageDir, "README.md"), `# ${packageName}\n\nPlatform prebuilt for @${ownerScope}/electron-overlay on ${platform}-${arch}.\n`, "utf8");
await writeFile(join(packageDir, "package.json"), `${JSON.stringify({
  name: packageName,
  version: packageVersion,
  description: `Electron overlay native addon for ${platform}-${arch}.`,
  repository: {
    type: "git",
    url: "git+https://github.com/COVAS-Labs/electron-overlay.git"
  },
  main: "index.js",
  os: [platform],
  cpu: [arch],
  files: ["index.js", "metadata.json", "README.md", "x11_overlay.node"],
  publishConfig: { registry, access }
}, null, 2)}\n`, "utf8");

console.log(`Prepared ${packageName} in ${packageDir}`);
