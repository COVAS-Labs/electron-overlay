import assert from "node:assert/strict";
import test from "node:test";

import {
  configure,
  displayToOverlayRect,
  findWindow,
  getCapabilities
} from "../packages/electron-overlay/dist/index.js";

function createFakeWindow() {
  const calls = [];
  let destroyed = false;
  return {
    calls,
    destroy() { destroyed = true; },
    getNativeWindowHandle() {
      throw new Error("The Wayland backend must not request a native handle.");
    },
    isDestroyed() { return destroyed; },
    setBounds(bounds) { calls.push(["setBounds", bounds]); },
    setIgnoreMouseEvents(enabled) { calls.push(["setIgnoreMouseEvents", enabled]); },
    setAlwaysOnTop(enabled) { calls.push(["setAlwaysOnTop", enabled]); },
    setVisibleOnAllWorkspaces(enabled, options) {
      calls.push(["setVisibleOnAllWorkspaces", enabled, options]);
    }
  };
}

test("reports explicit Wayland compatibility capabilities", () => {
  const window = createFakeWindow();
  assert.deepEqual(getCapabilities(window, "wayland-electron"), {
    backend: "wayland-electron",
    clickThrough: true,
    aboveFullscreen: false,
    externalParent: false,
    parentDiscovery: false,
    globalPositioning: false,
    boundsCoordinateSpace: "electron-screen"
  });
  assert.deepEqual(displayToOverlayRect({
    bounds: { x: 1920, y: 0, width: 1280, height: 720 },
    nativeOrigin: { x: 3840, y: 0 },
    scaleFactor: 2
  }, window, "wayland-electron"), { x: 1920, y: 0, width: 1280, height: 720 });
});

test("applies supported policy through the Electron BrowserWindow", () => {
  const window = createFakeWindow();
  const overlay = configure(window, {
    backend: "wayland-electron",
    bounds: { x: 10.4, y: 20.6, width: 300.2, height: 199.8 },
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    allWorkspaces: true
  });

  assert.equal(overlay.getCapabilities().backend, "wayland-electron");
  assert.deepEqual(window.calls, [
    ["setBounds", { x: 10, y: 21, width: 300, height: 200 }],
    ["setIgnoreMouseEvents", true],
    ["setAlwaysOnTop", true],
    ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }]
  ]);
  assert.equal(overlay.attachParent({ title: "Elite" }), null);
  assert.equal(overlay.useParentBounds(), false);

  overlay.setClickThrough(false);
  overlay.setAlwaysOnTop(false);
  overlay.setBounds({ x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(overlay.getState(), {
    overlayXid: 0n,
    parent: null,
    bounds: { x: 0, y: 0, width: 640, height: 480 },
    position: "bounds",
    clickThrough: false,
    alwaysOnTop: false,
    preserveCompositing: true,
    allWorkspaces: true,
    closed: false
  });

  overlay.close();
  overlay.close();
  assert.equal(overlay.getState().closed, true);
  assert.throws(() => overlay.reapply(), /closed/);
});

test("fails honestly for unsupported Wayland parent positioning", () => {
  assert.throws(() => configure(createFakeWindow(), {
    backend: "wayland-electron",
    parent: { title: "Elite" },
    position: "parent"
  }), /does not support parent positioning/);
});

test("requires a BrowserWindow for the Wayland compatibility backend", () => {
  assert.throws(() => configure(Buffer.from([1]), {
    backend: "wayland-electron",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    position: "bounds"
  }), /requires the Electron BrowserWindow/);
});

test("does not invoke native discovery for the Wayland compatibility backend", () => {
  assert.equal(findWindow({ title: "Elite" }, { backend: "wayland-electron" }), null);
});
