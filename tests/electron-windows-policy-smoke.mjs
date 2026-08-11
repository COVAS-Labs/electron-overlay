import { setTimeout as delay } from "node:timers/promises";

import { app, BrowserWindow, screen } from "electron";

import { configure } from "../packages/electron-overlay/dist/index.js";

if (process.platform !== "win32") {
  throw new Error("The Windows policy smoke test is Windows-only.");
}

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

let stage = "waiting for app readiness";
let controller;
const windows = [];
const watchdog = setTimeout(() => {
  console.error(`Windows policy smoke test timed out while ${stage}.`);
  cleanup();
  app.exit(1);
}, 30_000);

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const availableBounds = centeredBounds(display.bounds, 640, 420);
  const initialBounds = inset(availableBounds, 80);
  const finalBounds = inset(availableBounds, 30);
  const overlayWindow = trackWindow(new BrowserWindow({
    ...initialBounds,
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { backgroundThrottling: false }
  }));

  stage = "loading the overlay renderer";
  await loadProbe(overlayWindow);
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);

  stage = "configuring and resizing the overlay";
  controller = configure(overlayWindow, {
    bounds: initialBounds,
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  controller.setBounds(finalBounds);
  controller.reapply();
  const state = controller.getState();
  if (!sameRect(state.bounds, finalBounds)) {
    throw new Error(`Win32 setBounds regression: expected ${JSON.stringify(finalBounds)}, got ${JSON.stringify(state.bounds)}.`);
  }
  if (!state.clickThrough) {
    throw new Error("Win32 click-through styles were not applied.");
  }

  stage = "verifying Win32 input policy styles";
  controller.setClickThrough(false);
  if (controller.getState().clickThrough) {
    throw new Error("Win32 click-through styles remained active while input was blocking.");
  }
  controller.setClickThrough(true);
  if (!controller.getState().clickThrough) {
    throw new Error("Win32 click-through styles were not restored.");
  }

  cleanup();
  clearTimeout(watchdog);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  cleanup();
  clearTimeout(watchdog);
  app.exit(1);
});

function trackWindow(window) {
  windows.push(window);
  return window;
}

async function loadProbe(window) {
  const html = `<!doctype html>
    <html>
      <body>
        <strong>Windows policy smoke test</strong>
      </body>
      <style>
        html, body { width: 100%; height: 100%; margin: 0; }
        body { display: grid; place-items: center; background: rgba(255, 80, 100, 0.35); color: white; font: 24px sans-serif; }
      </style>
    </html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function settleRenderer(window) {
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
  await delay(50);
}

function centeredBounds(displayBounds, desiredWidth, desiredHeight) {
  const width = Math.min(desiredWidth, displayBounds.width - 80);
  const height = Math.min(desiredHeight, displayBounds.height - 80);
  return {
    x: displayBounds.x + Math.round((displayBounds.width - width) / 2),
    y: displayBounds.y + Math.round((displayBounds.height - height) / 2),
    width,
    height
  };
}

function inset(bounds, amount) {
  return {
    x: bounds.x + amount,
    y: bounds.y + amount,
    width: bounds.width - amount * 2,
    height: bounds.height - amount * 2
  };
}

function sameRect(left, right) {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function cleanup() {
  try { controller?.close(); } catch {}
  controller = undefined;
  for (const window of windows.splice(0).reverse()) {
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch {}
  }
}
