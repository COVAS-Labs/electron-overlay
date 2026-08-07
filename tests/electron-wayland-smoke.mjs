import { app, BrowserWindow, screen } from "electron";

import {
  configure,
  displayToOverlayRect
} from "../packages/electron-overlay/dist/index.js";

if (process.platform !== "linux") {
  throw new Error("The native Wayland smoke test is Linux-only.");
}
if (process.env.XDG_SESSION_TYPE !== "wayland" || !process.env.WAYLAND_DISPLAY) {
  throw new Error("The native Wayland smoke test requires a Wayland session.");
}
if (process.env.DISPLAY) {
  throw new Error("DISPLAY must be unset so Electron cannot fall back to X11.");
}
if (app.commandLine.getSwitchValue("ozone-platform") !== "wayland") {
  throw new Error("Electron must be launched with --ozone-platform=wayland.");
}

let stage = "waiting for app readiness";
const watchdog = setTimeout(() => {
  console.error(`Electron native Wayland smoke test timed out while ${stage}.`);
  app.exit(1);
}, 30_000);

app.whenReady().then(async () => {
  stage = "creating the BrowserWindow";
  const display = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: 320,
    height: 180,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    focusable: false,
    show: false
  });
  const bounds = displayToOverlayRect(display, window, "auto");
  const overlay = configure(window, {
    backend: "auto",
    bounds: { ...bounds, width: 320, height: 180 },
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  stage = "mapping the BrowserWindow on Wayland";
  await window.loadURL("data:text/html,<body style='background:transparent'></body>");
  window.showInactive();
  stage = "exercising the Wayland Electron controller";

  const capabilities = overlay.getCapabilities();
  if (capabilities.backend !== "wayland-electron") {
    throw new Error(`Expected wayland-electron backend, got ${capabilities.backend}.`);
  }
  if (capabilities.globalPositioning || capabilities.externalParent) {
    throw new Error(`Unexpected Wayland capabilities: ${JSON.stringify(capabilities)}`);
  }

  overlay.setClickThrough(false);
  overlay.setClickThrough(true);
  overlay.setAlwaysOnTop(false);
  overlay.setAlwaysOnTop(true);
  overlay.reapply();

  const state = overlay.getState();
  if (state.closed || state.bounds.width !== 320 || state.bounds.height !== 180) {
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
