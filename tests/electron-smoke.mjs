import { app, BrowserWindow, screen } from "electron";

import { configure, displayToNativeRect } from "../packages/electron-overlay/dist/index.js";

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
    show: false
  });

  const overlay = configure(window.getNativeWindowHandle(), {
    bounds: { ...bounds, width: 320, height: 180 },
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  stage = "exercising the native controller";

  overlay.setClickThrough(false);
  overlay.setClickThrough(true);
  overlay.setAlwaysOnTop(false);
  overlay.setAlwaysOnTop(true);
  window.showInactive();
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
