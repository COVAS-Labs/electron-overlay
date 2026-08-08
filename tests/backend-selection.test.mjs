import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { getBackendSelection } from "../packages/electron-overlay/dist/index.js";

test("explicit backend selection is certain on every platform", () => {
  assert.deepEqual(getBackendSelection(undefined, "wayland-electron"), {
    backend: "wayland-electron",
    source: "explicit",
    confidence: "certain",
    evidence: "backend=wayland-electron"
  });
});

test("buffer targets retain the native platform backend", () => {
  const selection = getBackendSelection(Buffer.from([1]));
  assert.equal(selection.source, "native-handle");
  assert.equal(selection.confidence, "certain");
  assert.equal(selection.backend, process.platform === "win32"
    ? "win32"
    : process.platform === "darwin" ? "macos" : "x11");
});

test("Linux auto detection reports its evidence", { skip: process.platform !== "linux" }, () => {
  assert.deepEqual(detect(["--ozone-platform=wayland"], {}), {
    backend: "wayland-electron",
    source: "ozone-argument",
    confidence: "certain",
    evidence: "--ozone-platform=wayland"
  });
  assert.deepEqual(detect([], {
    OZONE_PLATFORM: "x11",
    XDG_SESSION_TYPE: "wayland",
    WAYLAND_DISPLAY: "wayland-1"
  }).backend, "x11");
  assert.deepEqual(detect([], {
    XDG_SESSION_TYPE: "wayland",
    WAYLAND_DISPLAY: "wayland-1"
  }).backend, "wayland-electron");
  assert.deepEqual(detect([], {}).backend, "x11");
});

function detect(args, environment) {
  const moduleUrl = new URL("../packages/electron-overlay/dist/index.js", import.meta.url).href;
  const source = `import { getBackendSelection } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(getBackendSelection()));`;
  const env = { ...process.env, ...environment };
  for (const key of [
    "OZONE_PLATFORM",
    "ELECTRON_OZONE_PLATFORM_HINT",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY"
  ]) {
    if (!(key in environment)) delete env[key];
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, "--", ...args], {
    encoding: "utf8",
    env
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
