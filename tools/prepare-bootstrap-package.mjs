import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = process.argv[2];
if (!packageName?.startsWith("@covas-labs/electron-overlay")) {
  throw new Error("Expected an @covas-labs/electron-overlay package name.");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = resolve(repoRoot, "artifacts", "bootstrap", packageName.replaceAll(/[\/@]/g, "-"));
await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
await writeFile(resolve(packageDir, "README.md"), `# ${packageName}\n\nBootstrap placeholder. Install a stable release instead.\n`, "utf8");
await writeFile(resolve(packageDir, "index.js"), `throw new Error("${packageName} is a bootstrap placeholder.");\n`, "utf8");
await writeFile(resolve(packageDir, "package.json"), `${JSON.stringify({
  name: packageName,
  version: "0.0.0-bootstrap.0",
  description: "Bootstrap placeholder for the electron-overlay release pipeline.",
  repository: {
    type: "git",
    url: "git+https://github.com/COVAS-Labs/electron-overlay.git"
  },
  main: "index.js",
  files: ["index.js", "README.md"],
  publishConfig: {
    registry: "https://registry.npmjs.org",
    access: "public"
  }
}, null, 2)}\n`, "utf8");
console.log(packageDir);
