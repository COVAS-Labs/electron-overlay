import assert from "node:assert/strict";
import test from "node:test";

import { configure, displayToNativeRect } from "../packages/electron-overlay/dist/index.js";

test("converts Electron display bounds to platform-native coordinates", () => {
  assert.deepEqual(displayToNativeRect({
    bounds: { x: 1920, y: 0, width: 1280, height: 720 },
    nativeOrigin: { x: 3840, y: 0 },
    scaleFactor: 2
  }), process.platform === "darwin"
    ? { x: 1920, y: 0, width: 1280, height: 720 }
    : { x: 3840, y: 0, width: 2560, height: 1440 });
});

test("derives a native origin when Electron does not expose one", () => {
  assert.deepEqual(displayToNativeRect({
    bounds: { x: -1280, y: 0, width: 1280, height: 720 },
    scaleFactor: 1.25
  }), process.platform === "darwin"
    ? { x: -1280, y: 0, width: 1280, height: 720 }
    : { x: -1600, y: 0, width: 1600, height: 900 });
});

test("rejects invalid handles before loading the platform addon", () => {
  assert.throws(() => configure(Buffer.alloc(0), {
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    position: "bounds"
  }), /nativeWindowHandle/);
});

test("requires bounds for bounds positioning", () => {
  assert.throws(() => configure(Buffer.from([1]), { position: "bounds" }), /options.bounds/);
});
