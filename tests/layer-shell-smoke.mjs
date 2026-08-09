import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { app, BrowserWindow } from "electron";

import {
  createLayerShellOverlay,
  getLayerShellCapabilities
} from "../packages/electron-overlay/dist/index.js";

const execFileAsync = promisify(execFile);

if (process.platform !== "linux") throw new Error("The layer-shell smoke test is Linux-only.");
if (!process.env.WAYLAND_DISPLAY || process.env.DISPLAY) {
  throw new Error("The layer-shell smoke test requires native Wayland without DISPLAY.");
}
if (app.commandLine.getSwitchValue("ozone-platform") !== "wayland") {
  throw new Error("Electron must run with --ozone-platform=wayland.");
}

const watchdog = setTimeout(() => {
  console.error("Electron OSR layer-shell smoke test timed out.");
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
  console.log("Waiting for Electron app readiness.");
  await app.whenReady();
  console.log("Creating native layer-shell surface.");

  const capabilities = getLayerShellCapabilities();
  assert.equal(capabilities.renderingMode, "electron-offscreen");
  assert.equal(capabilities.aboveFullscreen, true);
  assert.equal(capabilities.outputPlacement, true);
  assert.equal(capabilities.globalPositioning, false);
  assert.equal(capabilities.preferredBufferTransport, "linux-dmabuf");
  assert.deepEqual(capabilities.bufferTransports, ["linux-dmabuf", "wl_shm"]);
  assert.equal(capabilities.shmFallback, true);

  const requestedOutput = process.env.LAYER_SHELL_OUTPUT;
  if (!requestedOutput) throw new Error("LAYER_SHELL_OUTPUT is required.");
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const overlayPromise = createLayerShellOverlay({
    placement: { type: "output", output: requestedOutput, anchor: "fill" },
    namespace: "covas-electron-overlay-osr-smoke",
    initializationTimeoutMs: 10_000
  });
  await delay(0);
  assert.equal(timerFired, true, "layer-shell initialization blocked the JavaScript event loop");
  const overlay = await overlayPromise;
  const initialState = overlay.getState();
  assert.deepEqual([initialState.width, initialState.height], [1920, 1080]);
  console.log(`Creating ${initialState.width}x${initialState.height} offscreen BrowserWindow.`);

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
        useSharedTexture: false,
        deviceScaleFactor: 1
      }
    }
  });
  let latestPaintChecksum = 0;
  window.webContents.setFrameRate(30);
  window.webContents.on("paint", (_event, _dirtyRect, image) => {
    latestPaintChecksum = checksum(image.toBitmap({ scaleFactor: 1 }));
  });
  overlay.attachOffscreenWindow(window);

  try {
    console.log("Loading Electron offscreen renderer.");
    await window.loadURL(`data:text/html,${encodeURIComponent(`
      <style>
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
        body { background: linear-gradient(90deg, rgba(255,0,0,.75) 0 25%, #00ff00 25% 50%, #0000ff 50% 75%, transparent 75%); }
      </style>
    `)}`);
    await waitForFrame(overlay, requestedOutput, () => latestPaintChecksum);
    console.log("Received initial Electron offscreen frame.");
    const firstSubmitted = overlay.getState().submittedFrameCount;

    const firstFrameCount = overlay.getState().frameCount;
    await window.webContents.executeJavaScript(
      "document.body.style.background = 'rgba(32, 96, 192, 0.5)'"
    );
    window.webContents.invalidate();
    await waitUntil(() => {
      const state = overlay.getState();
      if (state.error || state.renderError) throw new Error(state.error ?? state.renderError);
      return state.submittedFrameCount > firstSubmitted
        && state.frameCount > firstFrameCount
        && state.lastFrameChecksum === latestPaintChecksum;
    }, "updated Electron OSR frame");

    const beforeResize = overlay.getState();
    await execFileAsync("swaymsg", ["output", requestedOutput, "mode", "1280x720"]);
    try {
      await waitUntil(() => {
        const state = overlay.getState();
        if (state.error || state.renderError) throw new Error(state.error ?? state.renderError);
        return state.width === 1280
          && state.height === 720
          && state.submittedFrameCount > beforeResize.submittedFrameCount
          && state.frameCount > beforeResize.frameCount
          && state.lastFrameChecksum === latestPaintChecksum;
      }, "OSR repaint after compositor output resize");
    } catch (error) {
      throw new Error(`${error} State: ${JSON.stringify(overlay.getState())}; BrowserWindow: ${window.getContentSize()}; paint checksum: ${latestPaintChecksum}`);
    }

    const state = overlay.getState();
    assert.equal(state.output, requestedOutput);
    assert.equal(state.sourceAttached, true);
    assert.equal(state.renderError, undefined);
    assert.equal(state.bufferBackend, "wl_shm");
    assert.equal(typeof state.dmabufAdvertised, "boolean");
    assert.equal(typeof state.dmabufUsable, "boolean");
    assert.equal(state.dmabufSubmittedFrameCount, 0);
    assert.equal(state.dmabufImportFailureCount, 0);
    assert.ok(state.frameCount >= 4);
    assert.ok(state.bufferReleaseCount >= 3);
    console.log(`Rendered Electron OSR through ${state.bufferBackend}: ${JSON.stringify(state)}`);
  } finally {
    overlay.close();
    const closedState = overlay.getState();
    assert.equal(closedState.closed, true);
    assert.equal(closedState.mapped, false);
    assert.equal(closedState.sourceAttached, false);
    window.destroy();
  }
}

async function waitForFrame(overlay, expectedOutput, currentChecksum) {
  await waitUntil(() => {
    const state = overlay.getState();
    if (state.error || state.renderError) throw new Error(state.error ?? state.renderError);
    return state.configured && state.mapped
      && state.output === expectedOutput
      && state.submittedFrameCount >= 1
      && state.lastFrameChecksum !== 0
      && state.lastFrameChecksum === currentChecksum();
  }, "initial Electron OSR frame");
}

async function waitUntil(condition, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function checksum(buffer) {
  let value = 2166136261;
  for (const byte of buffer) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}
