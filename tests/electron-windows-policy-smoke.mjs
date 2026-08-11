import { execFileSync } from "node:child_process";
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
  const stageBounds = centeredBounds(display.bounds, 640, 420);
  const initialBounds = inset(stageBounds, 80);
  const finalBounds = inset(stageBounds, 30);
  const reference = trackWindow(new BrowserWindow({
    ...stageBounds,
    show: false,
    frame: false,
    resizable: false,
    backgroundColor: "#14263d",
    webPreferences: { backgroundThrottling: false }
  }));
  const overlayWindow = trackWindow(new BrowserWindow({
    ...initialBounds,
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { backgroundThrottling: false }
  }));

  stage = "loading click probes";
  await Promise.all([
    loadProbe(reference, "reference", "#14263d"),
    loadProbe(overlayWindow, "overlay", "rgba(255, 80, 100, 0.35)")
  ]);
  reference.show();
  overlayWindow.showInactive();
  await Promise.all([settleRenderer(reference), settleRenderer(overlayWindow)]);

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

  stage = "verifying click-through input";
  await delay(200);
  clickDesktop(center(finalBounds));
  await waitUntil(() => clickCount(reference), "reference click-through delivery");
  if (await clickCount(overlayWindow) !== 0) {
    throw new Error("The click-through overlay received input intended for the reference window.");
  }

  stage = "verifying restored overlay input";
  controller.setClickThrough(false);
  await delay(200);
  clickDesktop(center(finalBounds));
  await waitUntil(() => clickCount(overlayWindow), "overlay input delivery");
  if (await clickCount(reference) !== 1) {
    throw new Error("The reference window received input while the overlay was input-blocking.");
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

async function loadProbe(window, name, background) {
  const html = `<!doctype html>
    <html>
      <body>
        <strong>${name}</strong>
        <script>
          globalThis.clickCount = 0;
          addEventListener("pointerdown", () => { globalThis.clickCount += 1; });
        </script>
      </body>
      <style>
        html, body { width: 100%; height: 100%; margin: 0; }
        body { display: grid; place-items: center; background: ${background}; color: white; font: 24px sans-serif; }
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

async function clickCount(window) {
  return window.webContents.executeJavaScript("globalThis.clickCount");
}

function clickDesktop(point) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ElectronOverlayCiMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
if (-not [ElectronOverlayCiMouse]::SetCursorPos(${point.x}, ${point.y})) { throw "SetCursorPos failed." }
[ElectronOverlayCiMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[ElectronOverlayCiMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "inherit"
  });
}

async function waitUntil(probe, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
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

function center(bounds) {
  return {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
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
