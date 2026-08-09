import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { app, BrowserWindow } from "electron";

import { createLayerShellOverlay } from "../packages/electron-overlay/dist/index.js";

if (process.platform !== "linux") throw new Error("The shared-texture smoke test is Linux-only.");
if (!process.env.WAYLAND_DISPLAY || process.env.DISPLAY) {
  throw new Error("The shared-texture smoke test requires native Wayland without DISPLAY.");
}

const watchdog = setTimeout(() => {
  console.error("Electron shared-texture layer-shell smoke test timed out.");
  app.exit(1);
}, 30_000);

main().then(() => {
  clearTimeout(watchdog);
  app.quit();
}).catch((error) => {
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
});

async function main() {
  await app.whenReady();
  const output = process.env.LAYER_SHELL_OUTPUT;
  if (!output) throw new Error("LAYER_SHELL_OUTPUT is required.");
  const overlay = await createLayerShellOverlay({
    placement: { type: "output", output, anchor: "fill" },
    namespace: "covas-electron-overlay-shared-texture-smoke",
    initializationTimeoutMs: 10_000
  });
  const initialState = overlay.getState();
  const window = new BrowserWindow({
    width: initialState.width,
    height: initialState.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      backgroundThrottling: false,
      offscreen: {
        useSharedTexture: true,
        deviceScaleFactor: 1
      }
    }
  });
  let texturePaintCount = 0;
  window.webContents.setFrameRate(30);
  window.webContents.on("paint", (event) => {
    if (event.texture) texturePaintCount += 1;
  });
  overlay.attachOffscreenWindow(window);

  try {
    await window.loadURL(`data:text/html,${encodeURIComponent(`
      <style>
        html, body { width: 100%; height: 100%; margin: 0; background: rgba(80, 160, 240, .75); }
      </style>
    `)}`);
    await waitUntil(() => {
      const state = overlay.getState();
      if (state.error || state.renderError) throw new Error(state.error ?? state.renderError);
      return state.submittedFrameCount > 0 && state.frameCount > initialState.frameCount;
    }, "shared-texture rendering or SHM readback fallback");

    const state = overlay.getState();
    assert.equal(state.sourceAttached, true);
    assert.ok(state.bufferBackend === "linux-dmabuf" || state.bufferBackend === "wl_shm");
    if (state.bufferBackend === "linux-dmabuf") {
      assert.ok(state.dmabufSubmittedFrameCount > 0);
      assert.ok(texturePaintCount > 0);
    }
    console.log(`Shared-texture OSR result: textures=${texturePaintCount} state=${JSON.stringify(state)}`);
  } finally {
    overlay.close();
    window.destroy();
  }
}

async function waitUntil(condition, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
