import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLayerShellOverlay } from "../packages/electron-overlay/dist/index.js";

if (process.platform !== "linux") throw new Error("The native layer-shell smoke test is Linux-only.");
if (!process.env.WAYLAND_DISPLAY || process.env.DISPLAY) {
  throw new Error("The native layer-shell smoke test requires native Wayland without DISPLAY.");
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
const connections = new Set();
const server = createServer((socket) => {
  connections.add(socket);
  socket.once("close", () => connections.delete(socket));
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(stalledSocket, resolveListen);
});
process.env.WAYLAND_DISPLAY = stalledSocket;
const started = Date.now();
try {
  await assert.rejects(createLayerShellOverlay({
    placement: { type: "output", output: "timeout-test", anchor: "fill" },
    initializationTimeoutMs: 100
  }), /Timed out while discovering Wayland globals/);
  assert.ok(Date.now() - started < 2_000, "native initialization timeout was not bounded");
} finally {
  process.env.WAYLAND_DISPLAY = compositorDisplay;
  for (const socket of connections) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log("Native layer-shell lifecycle and timeout checks passed.");
