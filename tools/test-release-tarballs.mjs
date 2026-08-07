import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getReleaseTarget, prebuiltPackageName, releaseTargetId } from "./release-targets.mjs";
import { npmInvocation, parseArgs, readJson, verifyArtifactRecord } from "./release-artifact-utils.mjs";

const require = createRequire(import.meta.url);
const args = parseArgs(process.argv.slice(2));
const artifactDir = resolve(args["artifact-dir"] ?? "artifacts/download");
const version = args["package-version"];
const target = getReleaseTarget();
const targetId = releaseTargetId(target);
assert.equal(process.env.EXPECTED_TARGET ?? targetId, targetId, "Runner target mismatch");
const publicRecord = await readJson(resolve(artifactDir, "public.json"));
const prebuiltRecord = await readJson(resolve(artifactDir, `prebuilt-${targetId}.json`));
assert.equal(publicRecord.version, version);
assert.equal(prebuiltRecord.version, version);
assert.equal(publicRecord.package, "@covas-labs/electron-overlay");
assert.equal(prebuiltRecord.package, prebuiltPackageName("covas-labs", target));
const publicTarball = await verifyArtifactRecord(publicRecord, artifactDir);
const prebuiltTarball = await verifyArtifactRecord(prebuiltRecord, artifactDir);
const consumerDir = await mkdtemp(resolve(tmpdir(), "electron-overlay-release-test-"));

try {
  await writeFile(resolve(consumerDir, "package.json"), `${JSON.stringify({
    name: "electron-overlay-release-test",
    private: true,
    type: "module",
    dependencies: {
      [publicRecord.package]: pathToFileURL(publicTarball).href,
      [prebuiltRecord.package]: pathToFileURL(prebuiltTarball).href
    }
  }, null, 2)}\n`, "utf8");
  runNpm(["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock", "--offline", "--omit=optional", "--omit=peer"], consumerDir);
  const testPath = resolve(consumerDir, "load-packages.mjs");
  await writeFile(testPath, `
import assert from "node:assert/strict";
const overlay = await import(${JSON.stringify(publicRecord.package)});
assert.equal(typeof overlay.configure, "function");
assert.deepEqual(overlay.displayToNativeRect({ bounds: { x: 1, y: 2, width: 3, height: 4 }, scaleFactor: 1 }), { x: 1, y: 2, width: 3, height: 4 });
try { overlay.findWindow({ title: "__electron_overlay_release_validation__", match: "exact" }); } catch (error) {
  if (process.platform !== "linux" || !String(error).includes("Could not open the X11 display")) throw error;
}
console.log("Loaded exact release tarballs for ${targetId}.");
`.trimStart(), "utf8");
  const electronExecutable = require("electron");
  const result = spawnSync(electronExecutable, process.platform === "linux" ? ["--no-sandbox", testPath] : [testPath], {
    cwd: consumerDir,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron package test failed with status ${result.status}.`);
} finally {
  await rm(consumerDir, { recursive: true, force: true });
}

function runNpm(npmArgs, cwd) {
  const npm = npmInvocation(npmArgs);
  const result = spawnSync(npm.command, npm.args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, npm_config_cache: resolve(cwd, ".npm-cache"), npm_config_update_notifier: "false" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install failed with status ${result.status}.`);
}
