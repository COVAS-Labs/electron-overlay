import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createLayerShellOverlay,
  getLayerShellCapabilities
} from "../packages/electron-overlay/dist/index.js";

if (process.platform !== "linux") {
  throw new Error("The layer-shell smoke test is Linux-only.");
}
if (!process.env.WAYLAND_DISPLAY || process.env.DISPLAY) {
  throw new Error("The layer-shell smoke test requires native Wayland without DISPLAY.");
}

const require = createRequire(import.meta.url);
const nativeAddon = require(fileURLToPath(new URL(
  "../packages/native-addon/build/Release/wayland_layer_shell.node",
  import.meta.url
)));
const closedController = nativeAddon.createLayerShellOverlay({});
closedController.close();
assert.throws(() => closedController.initialize(), /closed/);

const compositorDisplay = process.env.WAYLAND_DISPLAY;
const stalledSocket = resolve(process.env.XDG_RUNTIME_DIR, "electron-overlay-stalled-wayland");
const stalledConnections = new Set();
const stalledServer = createServer((socket) => {
  stalledConnections.add(socket);
  socket.once("close", () => stalledConnections.delete(socket));
});
await new Promise((resolveListen, rejectListen) => {
  stalledServer.once("error", rejectListen);
  stalledServer.listen(stalledSocket, resolveListen);
});
process.env.WAYLAND_DISPLAY = stalledSocket;
const timeoutStarted = Date.now();
try {
  await assert.rejects(
    createLayerShellOverlay({
      placement: { type: "output", output: "timeout-test", anchor: "fill" },
      initializationTimeoutMs: 100
    }),
    /Timed out while discovering Wayland globals/
  );
  assert.ok(Date.now() - timeoutStarted < 2_000, "native initialization timeout was not bounded");
} finally {
  process.env.WAYLAND_DISPLAY = compositorDisplay;
  for (const socket of stalledConnections) socket.destroy();
  await new Promise((resolveClose) => stalledServer.close(resolveClose));
}

const capabilities = getLayerShellCapabilities();
if (!capabilities.aboveFullscreen || !capabilities.outputPlacement || capabilities.globalPositioning) {
  throw new Error(`Unexpected layer-shell capabilities: ${JSON.stringify(capabilities)}`);
}

const requestedOutput = process.env.LAYER_SHELL_OUTPUT;
if (!requestedOutput) throw new Error("LAYER_SHELL_OUTPUT is required.");
let timerFired = false;
setTimeout(() => { timerFired = true; }, 0);
const overlayPromise = createLayerShellOverlay({
  placement: { type: "output", output: requestedOutput, anchor: "fill" },
  namespace: "covas-electron-overlay-smoke",
  initializationTimeoutMs: 10_000
});
await delay(0);
if (!timerFired) throw new Error("Layer-shell initialization blocked the JavaScript event loop.");
const overlay = await overlayPromise;

try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = overlay.getState();
    if (state.error) throw new Error(state.error);
    if (state.configured && state.mapped && state.frameCount >= 2 && state.bufferReleaseCount >= 1) {
      if (requestedOutput && state.output !== requestedOutput) {
        throw new Error(`Expected output ${requestedOutput}, got ${state.output ?? "none"}.`);
      }
      console.log(`Mapped layer-shell test surface: ${JSON.stringify(state)}`);
      process.exitCode = 0;
      break;
    }
    await delay(25);
  }
  const state = overlay.getState();
  if (state.frameCount < 2 || state.bufferReleaseCount < 1) {
    throw new Error(`Layer-shell frame lifecycle timed out: ${JSON.stringify(state)}`);
  }
} finally {
  overlay.close();
  const closedState = overlay.getState();
  assert.equal(closedState.closed, true);
  assert.equal(closedState.mapped, false);
}
