import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { getReleaseTarget, prebuiltPackageName, releaseTargetId } from "./release-targets.mjs";
import { npmInvocation, parseArgs } from "./release-artifact-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const version = args["package-version"];
const target = getReleaseTarget();
const targetId = releaseTargetId(target);
const packageName = "@covas-labs/electron-overlay";
const prebuiltName = prebuiltPackageName("covas-labs", target);
const electronVersion = process.env.ELECTRON_VERSION ?? "43.3.0";
assert.equal(process.env.EXPECTED_TARGET ?? targetId, targetId, "Runner target mismatch");
assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
const consumerDir = await mkdtemp(resolve(tmpdir(), "electron-overlay-registry-test-"));

try {
  await writeFile(resolve(consumerDir, "package.json"), `${JSON.stringify({ name: "electron-overlay-registry-test", private: true, type: "module" })}\n`);
  let install;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    install = runNpm(["install", "--legacy-peer-deps", "--no-audit", "--no-fund", `${packageName}@${version}`, `electron@${electronVersion}`], consumerDir);
    if (install.status === 0) break;
    if (attempt < 30) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10000));
  }
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const metadata = JSON.parse(await readFile(resolve(consumerDir, "node_modules", ...prebuiltName.split("/"), "metadata.json"), "utf8"));
  assert.deepEqual(metadata, { packageName: prebuiltName, packageVersion: version, runtime: "electron", platform: target.platform, arch: target.arch });
  const testPath = resolve(consumerDir, "load-package.mjs");
  await writeFile(testPath, `
import assert from "node:assert/strict";
const overlay = await import(${JSON.stringify(packageName)});
assert.equal(typeof overlay.configure, "function");
assert.equal(typeof overlay.createLayerShellOverlay, "function");
assert.equal(typeof overlay.LayerShellOverlayController.prototype.attachOffscreenWindow, "function");
assert.equal(overlay.getLayerShellCapabilities().renderingMode, "electron-offscreen");
try {
  assert.equal(overlay.findWindow({ title: "__electron_overlay_registry_validation__", match: "exact" }), null);
} catch (error) {
  if (process.platform !== "linux" || !String(error).includes("Could not open the X11 display")) throw error;
}
if (process.platform === "linux") {
  const { createRequire } = await import("node:module");
  const consumerRequire = createRequire(import.meta.url);
  const layerShell = consumerRequire(${JSON.stringify(`${prebuiltName}/wayland_layer_shell.node`)});
  assert.equal(typeof layerShell.createLayerShellOverlay, "function");
  const controller = layerShell.createLayerShellOverlay({});
  assert.equal(typeof controller.submitFrame, "function");
  controller.close();
}
console.log("Loaded the installed native addon through findWindow for ${targetId}.");
`.trimStart(), "utf8");
  const consumerRequire = createRequire(resolve(consumerDir, "package.json"));
  const electron = spawnSync(consumerRequire("electron"), [testPath], {
    cwd: consumerDir,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  if (electron.error) throw electron.error;
  assert.equal(electron.status, 0, `Electron import failed with status ${electron.status}`);
  const signatureAudit = runNpm(["audit", "signatures"], consumerDir);
  assert.equal(signatureAudit.status, 0, signatureAudit.stderr || signatureAudit.stdout);
} finally {
  await rm(consumerDir, { recursive: true, force: true });
}

function runNpm(npmArgs, cwd) {
  const npm = npmInvocation(npmArgs);
  const result = spawnSync(npm.command, npm.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: resolve(cwd, ".npm-cache"), npm_config_update_notifier: "false" }
  });
  if (result.error) throw result.error;
  return result;
}
