import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { app, BrowserWindow } from "electron";

const title = option("target-title", "electron-overlay demo parent target");
const scenario = option("scenario", "parent");
const readyFile = requiredOption("ready-file");
const commandFile = requiredOption("command-file");
const stateFile = requiredOption("state-file");
const initialBounds = {
  x: numberOption("x", 140),
  y: numberOption("y", 80),
  width: numberOption("width", 1000),
  height: numberOption("height", 640)
};

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (process.platform === "linux") app.commandLine.appendSwitch("ozone-platform", "x11");

let window;
let lastSequence = 0;
let stopping = false;

app.on("window-all-closed", () => app.quit());
main().catch((error) => {
  console.error(error);
  app.exit(1);
});

async function main() {
  await Promise.all([rm(readyFile, { force: true }), rm(commandFile, { force: true }), rm(stateFile, { force: true })]);
  await app.whenReady();
  window = new BrowserWindow({
    ...initialBounds,
    title,
    show: false,
    frame: false,
    resizable: true,
    backgroundColor: "#101a29",
    webPreferences: { backgroundThrottling: false }
  });
  const url = new URL("./renderer.html", import.meta.url);
  url.searchParams.set("model", JSON.stringify({
    role: "stage",
    scenario,
    result: "reference",
    windowTitle: title,
    title: "Separate-process parent target",
    subtitle: `PID ${process.pid}. Controlled independently from the overlay process.`
  }));
  await window.loadURL(url.href);
  window.setTitle(title);
  window.show();
  await settleRenderer();
  await writeJsonAtomic(readyFile, snapshot(0, "ready"));
  void commandLoop();
}

async function commandLoop() {
  while (!stopping && window && !window.isDestroyed()) {
    try {
      const command = JSON.parse(await readFile(commandFile, "utf8"));
      if (Number.isInteger(command.sequence) && command.sequence > lastSequence) {
        lastSequence = command.sequence;
        await applyCommand(command);
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
}

async function applyCommand(command) {
  switch (command.action) {
    case "set-bounds":
      window.setBounds(command.bounds);
      break;
    case "fullscreen":
      window.setFullScreen(Boolean(command.enabled));
      break;
    case "focus":
      window.focus();
      break;
    case "hide":
      window.hide();
      break;
    case "show":
      window.show();
      break;
    case "minimize":
      window.minimize();
      break;
    case "restore":
      window.restore();
      window.show();
      break;
    case "set-title":
      window.setTitle(String(command.title));
      break;
    case "close":
      stopping = true;
      await writeJsonAtomic(stateFile, { ...snapshot(command.sequence, command.action), closed: true });
      window.close();
      return;
    default:
      throw new Error(`Unknown target action '${command.action}'.`);
  }
  await settleRenderer();
  await writeJsonAtomic(stateFile, snapshot(command.sequence, command.action));
}

function snapshot(sequence, action) {
  return {
    schemaVersion: 1,
    processId: process.pid,
    sequence,
    action,
    title: window?.getTitle() ?? title,
    bounds: window && !window.isDestroyed() ? window.getBounds() : null,
    fullscreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    minimized: Boolean(window && !window.isDestroyed() && window.isMinimized()),
    visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
    focused: Boolean(window && !window.isDestroyed() && window.isFocused()),
    closed: Boolean(!window || window.isDestroyed())
  };
}

async function settleRenderer() {
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
  await delay(100);
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function numberOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a finite number.`);
  return Math.round(value);
}
