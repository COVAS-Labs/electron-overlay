import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = resolve(repoRoot, "artifacts", "npm-pack");
const artifacts = JSON.parse(await readFile(resolve(packDir, "artifacts.json"), "utf8"));
const publicTarball = resolve(packDir, artifacts.public.tarball);
const prebuiltTarball = resolve(packDir, artifacts.prebuilt.tarball);
const consumerDir = await mkdtemp(resolve(tmpdir(), "electron-overlay-consumer-"));

try {
  await writeFile(resolve(consumerDir, "package.json"), `${JSON.stringify({
    name: "electron-overlay-package-consumer",
    private: true,
    type: "module",
    dependencies: {
      [artifacts.public.package]: pathToFileURL(publicTarball).href,
      [artifacts.prebuilt.package]: pathToFileURL(prebuiltTarball).href
    }
  }, null, 2)}\n`, "utf8");

  runNpm([
    "install",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--offline",
    "--omit=optional",
    "--omit=peer"
  ], consumerDir);

  const testSource = `
import assert from "node:assert/strict";

assert.ok(process.versions.electron, "consumer must run under Electron");
const overlay = await import(${JSON.stringify(artifacts.public.package)});
assert.equal(typeof overlay.configure, "function");
assert.deepEqual(
  overlay.displayToNativeRect({ bounds: { x: 1, y: 2, width: 3, height: 4 }, scaleFactor: 1 }),
  { x: 1, y: 2, width: 3, height: 4 }
);
try {
  overlay.findWindow({ title: "__electron_overlay_package_validation__", match: "exact" });
} catch (error) {
  if (process.platform !== "linux" || !String(error).includes("Could not open the X11 display")) throw error;
}
console.log("Loaded ${artifacts.prebuilt.package} through ${artifacts.public.package} under Electron.");
`;
  const testPath = resolve(consumerDir, "load-packages.mjs");
  await writeFile(testPath, testSource.trimStart(), "utf8");

  const electronExecutable = require("electron");
  const electronArgs = process.platform === "linux"
    ? ["--no-sandbox", testPath]
    : [testPath];
  const result = spawnSync(electronExecutable, electronArgs, {
    cwd: consumerDir,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(consumerDir, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run the consumer test through npm run test:package-consumer.");
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: resolve(cwd, ".npm-cache"),
      npm_config_update_notifier: "false"
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed with status ${result.status}.`);
}
