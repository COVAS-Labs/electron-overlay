import { app, BrowserWindow, screen } from "electron";

import { configure, displayToNativeRect } from "../packages/electron-overlay/dist/index.js";

const expectedBackend = {
  darwin: "macos",
  linux: "x11",
  win32: "win32"
}[process.platform];

if (!expectedBackend) {
  throw new Error(`Unsupported smoke test platform: ${process.platform}`);
}

if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform", "x11");
}

let stage = "waiting for app readiness";
const watchdog = setTimeout(() => {
  console.error(`Electron overlay smoke test timed out while ${stage}.`);
  app.exit(1);
}, 30_000);

app.whenReady().then(() => {
  stage = "creating the BrowserWindow";
  const display = screen.getPrimaryDisplay();
  const bounds = displayToNativeRect(display);
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: 320,
    height: 180,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    focusable: false,
    resizable: false,
    show: false
  });

  const overlay = configure(window, {
    backend: process.platform === "linux" ? "x11" : "auto",
    bounds: { ...bounds, width: 320, height: 180 },
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  stage = "exercising the native controller";

  const capabilities = overlay.getCapabilities();
  if (capabilities.backend !== expectedBackend) {
    throw new Error(`Expected ${expectedBackend} backend, got ${capabilities.backend}.`);
  }

  overlay.setClickThrough(false);
  overlay.setClickThrough(true);
  overlay.setAlwaysOnTop(false);
  overlay.setAlwaysOnTop(true);
  const resizedBounds = { ...bounds, x: bounds.x + 24, y: bounds.y + 24, width: 360, height: 220 };
  overlay.setBounds(resizedBounds);
  window.showInactive();
  overlay.reapply();

  const state = overlay.getState();
  if (state.closed || state.bounds.x !== resizedBounds.x || state.bounds.y !== resizedBounds.y
      || state.bounds.width !== resizedBounds.width || state.bounds.height !== resizedBounds.height) {
    throw new Error(`Unexpected overlay state: ${JSON.stringify(state, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value)}`);
  }

  overlay.close();
  window.destroy();
  clearTimeout(watchdog);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
