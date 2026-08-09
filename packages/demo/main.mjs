import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, screen } from "electron";

import {
  configure,
  createLayerShellOverlay,
  displayToNativeRect,
  displayToOverlayRect,
  findWindow,
  getBackendSelection,
  getCapabilities,
  getLayerShellCapabilities
} from "@covas-labs/electron-overlay";

const SCENARIOS = JSON.parse(readFileSync(new URL("./scenarios.json", import.meta.url), "utf8"));
const SCENARIO_IDS = SCENARIOS.map(({ id }) => id);
const scenario = option("demo", process.env.ELECTRON_OVERLAY_DEMO ?? "bounds");
const readyFile = option("ready-file", process.env.ELECTRON_OVERLAY_DEMO_READY_FILE);
const exitAfterReady = numberOption("exit-after-ready", 0);
const cleanups = [];
const windows = new Set();

if (!SCENARIO_IDS.includes(scenario)) {
  throw new Error(`Unknown demo '${scenario}'. Expected one of: ${SCENARIO_IDS.join(", ")}.`);
}

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const backend = selectBackend();
if (process.platform === "linux") {
  const ozonePlatform = scenario === "layer-shell" || scenario === "wayland-compat" ? "wayland" : backend;
  app.commandLine.appendSwitch("ozone-platform", ozonePlatform);
}

app.on("before-quit", cleanup);
app.on("window-all-closed", () => app.quit());

main().catch((error) => {
  console.error(error);
  cleanup();
  app.exit(1);
});

async function main() {
  if (readyFile) await rm(readyFile, { force: true });
  await app.whenReady();
  const runners = {
    bounds: runBoundsDemo,
    policy: runPolicyDemo,
    parent: runParentDemo,
    "parent-fullscreen": runParentFullscreenDemo,
    "parent-transition": runParentTransitionDemo,
    "parent-geometry": runParentGeometryDemo,
    "parent-lifecycle": runParentLifecycleDemo,
    "parent-matching": runParentMatchingDemo,
    "input-blocking": runInputBlockingDemo,
    "wayland-compat": runWaylandCompatibilityDemo,
    coordinates: runCoordinatesDemo,
    "layer-shell": runLayerShellDemo
  };
  const report = await runners[scenario]();
  await announceReady(report);
}

function selectBackend() {
  const requested = option("backend", process.env.ELECTRON_OVERLAY_DEMO_BACKEND);
  if (requested) {
    if (!["x11", "wayland-electron"].includes(requested)) {
      throw new Error("--backend must be x11 or wayland-electron.");
    }
    return requested;
  }
  if (process.platform !== "linux") return "auto";
  return process.env.XDG_SESSION_TYPE === "wayland" && process.env.WAYLAND_DISPLAY
    ? "wayland-electron"
    : "x11";
}

async function runBoundsDemo() {
  const requestedCapabilities = getCapabilities(undefined, backend);
  if (!requestedCapabilities.globalPositioning) {
    return runUnsupportedDemo("bounds", requestedCapabilities.backend,
      "This backend cannot deterministically position two independent top-level windows.", {
        globalPositioning: requestedCapabilities.globalPositioning,
        coordinateSpace: requestedCapabilities.boundsCoordinateSpace
      });
  }
  const display = screen.getPrimaryDisplay();
  const stageBounds = centeredBounds(display.bounds, 1080, 700);
  const initialBounds = inset(stageBounds, 110);
  const overlayBounds = inset(stageBounds, 70);
  const stage = createWindow(stageBounds, { backgroundColor: "#101a29" });
  await loadModel(stage, stageModel("bounds", "Fixed-bounds reference window"));
  stage.show();

  const overlayWindow = createOverlayWindow(initialBounds);
  await loadModel(overlayWindow, waitingOverlayModel("bounds", "Mapping fixed-bounds overlay"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const selection = getBackendSelection(overlayWindow, backend);
  const controller = configure(overlayWindow, {
    backend,
    bounds: overlayBounds,
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  registerController(controller);
  controller.reapply();
  const state = controller.getState();
  const capabilities = controller.getCapabilities();
  if (!sameRect(state.bounds, overlayBounds)) throw new Error("Native bounds configuration was not applied.");
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "bounds",
    result: "pass",
    title: "Fixed bounds overlay",
    subtitle: "A transparent Electron surface positioned by the native policy controller.",
    trace: [
      "getBackendSelection(window, backend)",
      "displayToOverlayRect(display, window, backend)",
      "configure(window, { position: 'bounds' })",
      "overlay.reapply()",
      "overlay.getState()"
    ],
    facts: {
      backend: selection.backend,
      source: selection.source,
      coordinateSpace: capabilities.boundsCoordinateSpace,
      clickThrough: state.clickThrough,
      alwaysOnTop: state.alwaysOnTop,
      bounds: rectLabel(state.bounds)
    },
    expectation: "Cyan panels sit above the blue grid; an OS click at the aperture center changes the underlying probe to RECEIVED."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("bounds", "pass", selection.backend, overlayWindow, {
    state,
    displayBounds: displayToOverlayRect(display, overlayWindow, backend)
  });
}

async function runPolicyDemo() {
  const requestedCapabilities = getCapabilities(undefined, backend);
  if (!requestedCapabilities.globalPositioning) {
    return runUnsupportedDemo("policy", requestedCapabilities.backend,
      "This backend cannot visually verify absolute setBounds() mutations between top-level windows.", {
        globalPositioning: requestedCapabilities.globalPositioning,
        coordinateSpace: requestedCapabilities.boundsCoordinateSpace
      });
  }
  const display = screen.getPrimaryDisplay();
  const stageBounds = centeredBounds(display.bounds, 1080, 700);
  const initialBounds = inset(stageBounds, 110);
  const finalBounds = inset(stageBounds, 55);
  const stage = createWindow(stageBounds, { backgroundColor: "#101a29" });
  await loadModel(stage, stageModel("policy", "Controller mutation reference window"));
  stage.show();

  const overlayWindow = createOverlayWindow(initialBounds);
  await loadModel(overlayWindow, waitingOverlayModel("policy", "Mapping controller policy overlay"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: initialBounds,
    position: "bounds",
    clickThrough: false,
    alwaysOnTop: false,
    preserveCompositing: true
  });
  registerController(controller);
  controller.setBounds(finalBounds);
  controller.setClickThrough(true);
  controller.setAlwaysOnTop(true);
  controller.reapply();
  const state = controller.getState();
  const capabilities = controller.getCapabilities();
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "policy",
    result: "pass",
    title: "Live controller policy",
    subtitle: "The final frame follows bounds, input, and stacking mutations applied after configuration.",
    trace: [
      "configure(window, initialPolicy)",
      "overlay.setBounds(finalBounds)",
      "overlay.setClickThrough(true)",
      "overlay.setAlwaysOnTop(true)",
      "overlay.reapply()"
    ],
    facts: {
      backend: capabilities.backend,
      clickThrough: state.clickThrough,
      alwaysOnTop: state.alwaysOnTop,
      position: state.position,
      closed: state.closed,
      finalBounds: rectLabel(state.bounds)
    },
    expectation: "Amber panels occupy the final rectangle; an OS click at the aperture center changes the underlying probe to RECEIVED."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("policy", "pass", capabilities.backend, overlayWindow, { state });
}

async function runParentDemo() {
  const display = screen.getPrimaryDisplay();
  const stageBounds = centeredBounds(display.bounds, 1000, 640);
  const parentTitle = "electron-overlay demo parent target";
  const capabilities = getCapabilities(undefined, backend);

  if (!capabilities.parentDiscovery || !capabilities.externalParent) {
    return runUnsupportedDemo("parent", capabilities.backend,
      "This backend cannot both discover and establish an external parent relationship.", {
        parentDiscovery: capabilities.parentDiscovery,
        externalParent: capabilities.externalParent
      });
  }

  const target = await spawnTarget({ scenario: "parent", title: parentTitle, bounds: stageBounds });

  const query = { title: parentTitle, match: "exact" };
  const discovered = await waitUntil(() => findWindow(query), "discoverable demo parent");
  const overlayWindow = createOverlayWindow(inset(stageBounds, 140));
  await loadModel(overlayWindow, waitingOverlayModel("parent", "Mapping parent attachment overlay"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: inset(stageBounds, 140),
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  registerController(controller);
  const attached = controller.attachParent(query, { reposition: false });
  const adoptedBounds = controller.useParentBounds();
  controller.reapply();
  const state = controller.getState();
  const result = attached && adoptedBounds && state.parent ? "pass" : "fail";
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "parent",
    result,
    title: "Parent discovery + attachment",
    subtitle: "The overlay discovered the reference window by title and adopted its exact native bounds.",
    trace: [
      "findWindow({ title, match: 'exact' })",
      "configure(window, { position: 'bounds' })",
      "overlay.attachParent(query, { reposition: false })",
      "overlay.useParentBounds()",
      "overlay.getState()"
    ],
    facts: {
      backend: capabilities.backend,
      discoveredTitle: discovered.title,
      targetProcessId: target.processId,
      separateProcess: target.processId !== process.pid,
      attached: Boolean(attached),
      externalParent: capabilities.externalParent,
      adoptedBounds,
      position: state.position
    },
    expectation: "Pink registration marks align with all four edges of the discoverable reference window."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  if (result !== "pass") throw new Error(`Parent demo failed: ${JSON.stringify(jsonSafe(state))}`);
  return reportFor("parent", result, capabilities.backend, overlayWindow, {
    query,
    discovered,
    target: target.ready,
    state
  });
}

async function runParentFullscreenDemo() {
  const display = screen.getPrimaryDisplay();
  const parentTitle = "electron-overlay fullscreen parent target";
  const target = await spawnTarget({
    scenario: "parent-fullscreen",
    title: parentTitle,
    bounds: centeredBounds(display.bounds, 1000, 640)
  });
  const query = { title: parentTitle, match: "exact" };
  const discovered = await waitUntil(() => findWindow(query), "fullscreen parent target");
  const overlayBounds = centeredBounds(display.bounds, 760, 430);
  const overlayWindow = createOverlayWindow(overlayBounds);
  await loadModel(overlayWindow, waitingOverlayModel("parent-fullscreen", "Mapping fullscreen HUD"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: overlayBounds,
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  registerController(controller);
  const attached = controller.attachParent(query, { reposition: false });
  const fullscreen = await commandTarget(target, "fullscreen", { enabled: true });
  const fullscreenParent = await waitUntil(() => {
    const parent = findWindow(query);
    return parent && parent.bounds.width >= display.bounds.width && parent.bounds.height >= display.bounds.height
      ? parent
      : null;
  }, "fullscreen native parent bounds");
  controller.reapply();
  const state = controller.getState();
  if (!attached || !state.parent || !fullscreen.fullscreen) throw new Error("Fullscreen parent attachment failed.");
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "parent-fullscreen",
    result: "pass",
    title: "HUD above fullscreen parent",
    subtitle: "A separate Electron process occupies the output while the attached native overlay remains visible.",
    trace: [
      "spawn separate target process",
      "overlay.attachParent(query, { reposition: false })",
      "target.setFullScreen(true)",
      "overlay.reapply()",
      "overlay.getState()"
    ],
    facts: {
      backend,
      targetPid: target.processId,
      fullscreen: fullscreen.fullscreen,
      parentBounds: rectLabel(fullscreenParent.bounds),
      overlayBounds: rectLabel(state.bounds),
      alwaysOnTop: state.alwaysOnTop
    },
    expectation: "Pink HUD panels remain visible above the fullscreen reference process."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("parent-fullscreen", "pass", backend, overlayWindow, {
    target: fullscreen,
    discovered,
    fullscreenParent,
    state
  });
}

async function runParentTransitionDemo() {
  const display = screen.getPrimaryDisplay();
  const parentTitle = "electron-overlay transition parent target";
  const target = await spawnTarget({
    scenario: "parent-transition",
    title: parentTitle,
    bounds: centeredBounds(display.bounds, 1000, 640)
  });
  const query = { title: parentTitle, match: "exact" };
  const initialParent = await waitUntil(() => findWindow(query), "transition parent target");
  const overlayWindow = createOverlayWindow(inset(initialParent.bounds, 120));
  await loadModel(overlayWindow, waitingOverlayModel("parent-transition", "Testing fullscreen transitions"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: inset(initialParent.bounds, 120),
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  registerController(controller);
  controller.attachParent(query, { reposition: false });
  controller.useParentBounds();
  const windowedBefore = controller.getState();

  const fullscreenTarget = await commandTarget(target, "fullscreen", { enabled: true });
  const fullscreenParent = await waitUntil(() => {
    const parent = findWindow(query);
    return parent
      && parent.bounds.width >= display.bounds.width
      && parent.bounds.height >= display.bounds.height
      ? parent
      : null;
  }, "fullscreen transition");
  const fullscreenAdopted = controller.useParentBounds();
  controller.reapply();
  const fullscreenState = controller.getState();

  const restored = await commandTarget(target, "fullscreen", { enabled: false });
  const restoredParent = await waitUntil(() => {
    const parent = findWindow(query);
    return parent && parent.bounds.width < display.bounds.width ? parent : null;
  }, "windowed restore transition");
  const restoredAdopted = controller.useParentBounds();
  controller.reapply();
  const restoredState = controller.getState();
  if (!fullscreenTarget.fullscreen || !fullscreenAdopted
      || !sameRect(fullscreenState.bounds, fullscreenParent.bounds)
      || !restoredAdopted || !sameRect(restoredState.bounds, restoredParent.bounds)) {
    throw new Error("Parent bounds were not preserved across fullscreen transitions.");
  }
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "parent-transition",
    result: "pass",
    title: "Windowed / fullscreen / windowed",
    subtitle: "The cross-process relationship survived both transitions and readopted current native bounds.",
    trace: [
      "overlay.useParentBounds()",
      "target.setFullScreen(true)",
      "overlay.useParentBounds()",
      "target.setFullScreen(false)",
      "overlay.useParentBounds()"
    ],
    facts: {
      initial: rectLabel(windowedBefore.bounds),
      fullscreen: rectLabel(fullscreenState.bounds),
      restored: rectLabel(restoredState.bounds),
      restoredTarget: rectLabel(restored.bounds),
      attached: Boolean(restoredState.parent)
    },
    expectation: "Pink registration marks realign with the restored windowed target after both mode transitions."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("parent-transition", "pass", backend, overlayWindow, {
    phases: { windowedBefore, fullscreenState, restoredState },
    target: restored
  });
}

async function runParentGeometryDemo() {
  const display = screen.getPrimaryDisplay();
  const parentTitle = "electron-overlay geometry parent target";
  const target = await spawnTarget({
    scenario: "parent-geometry",
    title: parentTitle,
    bounds: centeredBounds(display.bounds, 820, 540)
  });
  const query = { title: parentTitle, match: "exact" };
  const initialParent = await waitUntil(() => findWindow(query), "geometry parent target");
  const overlayWindow = createOverlayWindow(inset(initialParent.bounds, 80));
  await loadModel(overlayWindow, waitingOverlayModel("parent-geometry", "Testing native geometry adoption"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: inset(initialParent.bounds, 80),
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true
  });
  registerController(controller);
  controller.attachParent(query, { reposition: false });
  const requestedPhases = [
    { x: display.bounds.x + 80, y: display.bounds.y + 70, width: 760, height: 500 },
    { x: display.bounds.x + 260, y: display.bounds.y + 150, width: 900, height: 560 }
  ];
  const phases = [];
  let previousParent = initialParent;
  for (const requested of requestedPhases) {
    const targetState = await commandTarget(target, "set-bounds", { bounds: requested });
    if (process.env.SWAYSOCK) {
      execFileSync("swaymsg", [
        `[title="^${escapeSwayRegex(parentTitle)}$"]`,
        "move",
        "position",
        String(requested.x),
        String(requested.y)
      ], { stdio: "ignore" });
    }
    const parent = await waitUntil(() => {
      const current = findWindow(query);
      return current && !sameRect(current.bounds, previousParent.bounds) ? current : null;
    }, "updated parent geometry");
    if (!controller.useParentBounds()) throw new Error("useParentBounds() rejected a visible parent.");
    const overlay = controller.getState();
    if (!sameRect(overlay.bounds, parent.bounds)) throw new Error("Overlay did not adopt current parent geometry.");
    phases.push({ requested, target: targetState.bounds, parent: parent.bounds, overlay: overlay.bounds });
    previousParent = parent;
  }
  const state = controller.getState();
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "parent-geometry",
    result: "pass",
    title: "Moved + resized parent",
    subtitle: "Each explicit useParentBounds() call adopted the target's latest native geometry.",
    trace: ["target.setBounds(first)", "overlay.useParentBounds()", "target.setBounds(second)", "overlay.useParentBounds()"],
    facts: {
      phases: phases.length,
      targetPid: target.processId,
      finalParent: rectLabel(phases.at(-1).parent),
      finalOverlay: rectLabel(state.bounds),
      position: state.position
    },
    expectation: "Pink registration marks align with the moved and resized target's final edges."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("parent-geometry", "pass", backend, overlayWindow, { phases, state });
}

async function runParentLifecycleDemo() {
  const display = screen.getPrimaryDisplay();
  const parentTitle = "electron-overlay lifecycle parent target";
  const query = { title: parentTitle, match: "exact" };
  const missingBeforeStart = findWindow(query) === null;
  const first = await spawnTarget({
    scenario: "parent-lifecycle",
    title: parentTitle,
    bounds: centeredBounds(display.bounds, 900, 580)
  });
  const firstParent = await waitUntil(() => findWindow(query), "first lifecycle target");
  const overlayWindow = createOverlayWindow(inset(firstParent.bounds, 100));
  await loadModel(overlayWindow, waitingOverlayModel("parent-lifecycle", "Testing parent replacement"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: inset(firstParent.bounds, 100),
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true
  });
  registerController(controller);
  const firstAttached = controller.attachParent(query, { reposition: false });
  await stopTarget(first);
  const missingAfterClose = await waitUntil(() => findWindow(query) === null ? true : null, "closed parent removal");
  const staleParentRejected = controller.useParentBounds() === false;
  controller.detachParent();
  const detached = controller.getState().parent === null;

  const replacement = await spawnTarget({
    scenario: "parent-lifecycle",
    title: parentTitle,
    bounds: centeredBounds(display.bounds, 960, 600)
  });
  const replacementParent = await waitUntil(() => findWindow(query), "replacement lifecycle target");
  const replacementAttached = controller.attachParent(query, { reposition: false });
  const replacementAdopted = controller.useParentBounds();
  controller.reapply();
  const state = controller.getState();
  if (!missingBeforeStart || !firstAttached || !missingAfterClose || !staleParentRejected
      || !detached || !replacementAttached || !replacementAdopted || !sameRect(state.bounds, replacementParent.bounds)) {
    throw new Error("Parent lifecycle assertions failed.");
  }
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "parent-lifecycle",
    result: "pass",
    title: "Delayed / closed / replaced parent",
    subtitle: "The controller rejected stale geometry, detached cleanly, and attached to a replacement process.",
    trace: ["findWindow() -> null", "attach first target", "first target exits", "detachParent()", "attach replacement"],
    facts: {
      firstPid: first.processId,
      replacementPid: replacement.processId,
      staleParentRejected,
      detached,
      replacementBounds: rectLabel(state.bounds)
    },
    expectation: "Pink registration marks align with the replacement target and the report records distinct process IDs."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("parent-lifecycle", "pass", backend, overlayWindow, {
    missingBeforeStart,
    missingAfterClose,
    staleParentRejected,
    detached,
    firstProcessId: first.processId,
    replacementProcessId: replacement.processId,
    state
  });
}

async function runParentMatchingDemo() {
  const display = screen.getPrimaryDisplay();
  const firstTitle = "electron-overlay matching target alpha";
  const secondTitle = "electron-overlay matching target beta";
  const first = await spawnTarget({
    scenario: "parent-matching",
    title: firstTitle,
    bounds: { x: 80, y: 100, width: 520, height: 440 }
  });
  const second = await spawnTarget({
    scenario: "parent-matching",
    title: secondTitle,
    bounds: { x: 680, y: 180, width: 520, height: 440 }
  });
  const firstWindow = await waitUntil(() => findWindow({ title: firstTitle, match: "exact" }), "first matching target");
  const secondWindow = await waitUntil(() => findWindow({ title: secondTitle, match: "exact" }), "second matching target");
  const contains = findWindow({ title: "MATCHING TARGET ALP", match: "contains" });
  const classMatch = findWindow({ title: firstTitle, match: "exact", className: firstWindow.className });
  const wrongClass = findWindow({ title: firstTitle, match: "exact", className: `${firstWindow.className}-wrong` });
  const noMatch = findWindow({ title: "electron-overlay definitely absent", match: "exact" });
  const validationErrors = [];
  for (const query of [{ title: "" }, { title: firstTitle, match: "invalid" }]) {
    try { findWindow(query); } catch (error) { validationErrors.push(error.message); }
  }
  const duplicateTitle = "electron-overlay duplicate matching target";
  if (process.env.SWAYSOCK) focusSwayTitle(firstTitle);
  else await commandTarget(first, "focus");
  await commandTarget(first, "set-title", { title: duplicateTitle });
  await commandTarget(second, "set-title", { title: duplicateTitle });
  const activeMatch = await waitUntil(() => {
    const match = findWindow({ title: duplicateTitle, match: "exact" });
    return match?.xid === firstWindow.xid ? match : null;
  }, "active duplicate match");
  await commandTarget(second, "set-title", { title: secondTitle });
  if (process.env.SWAYSOCK) focusSwayTitle(secondTitle);
  else await commandTarget(second, "focus");
  await commandTarget(second, "set-title", { title: duplicateTitle });
  const activeSecondMatch = await waitUntil(() => {
    const match = findWindow({ title: duplicateTitle, match: "exact" });
    return match?.xid === secondWindow.xid ? match : null;
  }, "second active duplicate match");
  const window = createWindow(centeredBounds(display.bounds, 980, 640), { backgroundColor: "#101a29" });
  const pass = contains?.xid === firstWindow.xid && classMatch?.xid === firstWindow.xid
    && wrongClass === null && noMatch === null && validationErrors.length === 2
    && activeMatch.xid === firstWindow.xid && activeSecondMatch.xid === secondWindow.xid;
  if (!pass) throw new Error("Parent matching assertions failed.");
  await loadModel(window, {
    role: "info",
    scenario: "parent-matching",
    result: "pass",
    title: "Parent query selection",
    subtitle: "Independent target processes validate exact, contains, class, missing, invalid, and active duplicate queries.",
    trace: ["findWindow(exact)", "findWindow(contains)", "findWindow(className)", "findWindow(no match)", "focus duplicate candidates"],
    facts: {
      firstPid: first.processId,
      secondPid: second.processId,
      className: firstWindow.className,
      containsMatched: Boolean(contains),
      wrongClassRejected: wrongClass === null,
      validationErrors: validationErrors.length,
      activeCandidatesSelected: 2
    },
    expectation: "The green diagnostic card reports PASS after both duplicate candidates win while active."
  });
  window.show();
  await settleRenderer(window);
  return reportFor("parent-matching", "pass", backend, window, {
    firstWindow,
    secondWindow,
    contains,
    classMatch,
    validationErrors,
    activeMatch,
    activeSecondMatch
  });
}

async function runInputBlockingDemo() {
  const display = screen.getPrimaryDisplay();
  const stageBounds = centeredBounds(display.bounds, 1080, 700);
  const overlayBounds = inset(stageBounds, 70);
  const stage = createWindow(stageBounds, { backgroundColor: "#101a29" });
  await loadModel(stage, stageModel("input-blocking", "Input recipient reference window"));
  stage.show();
  const overlayWindow = createWindow(overlayBounds, {
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false
  });
  await loadModel(overlayWindow, waitingOverlayModel("input-blocking", "Mapping input-blocking overlay"));
  overlayWindow.showInactive();
  await settleRenderer(overlayWindow);
  const controller = configure(overlayWindow, {
    backend,
    bounds: overlayBounds,
    position: "bounds",
    clickThrough: false,
    alwaysOnTop: true,
    preserveCompositing: true
  });
  registerController(controller);
  const state = controller.getState();
  await setModel(overlayWindow, {
    role: "overlay",
    scenario: "input-blocking",
    result: "pass",
    pointerProbe: true,
    title: "Input-blocking overlay",
    subtitle: "The native input shape is restored, so the overlay receives the compositor pointer event.",
    trace: ["configure(window, { clickThrough: false })", "overlay.getState()", "inject XTEST pointer input"],
    facts: { backend, clickThrough: state.clickThrough, alwaysOnTop: state.alwaysOnTop, bounds: rectLabel(state.bounds) },
    expectation: "An OS click changes the amber overlay probe to RECEIVED while the cyan reference probe remains ARMED."
  });
  controller.reapply();
  await settleRenderer(overlayWindow);
  return reportFor("input-blocking", "pass", backend, overlayWindow, { state });
}

async function runWaylandCompatibilityDemo() {
  const display = screen.getPrimaryDisplay();
  const bounds = centeredBounds(display.bounds, 980, 640);
  const window = createOverlayWindow(bounds);
  await loadModel(window, waitingOverlayModel("wayland-compat", "Testing native Wayland limitations"));
  window.showInactive();
  await settleRenderer(window);
  const capabilities = getCapabilities(window, "wayland-electron");
  const query = { title: "unavailable native Wayland parent", match: "exact" };
  const discovery = findWindow(query, { backend: "wayland-electron" });
  let parentPositionError = "";
  try {
    configure(window, { backend: "wayland-electron", position: "parent", parent: query });
  } catch (error) {
    parentPositionError = error.message;
  }
  const controller = configure(window, {
    backend: "wayland-electron",
    bounds,
    position: "bounds",
    clickThrough: true,
    alwaysOnTop: true,
    allWorkspaces: false
  });
  registerController(controller);
  const attached = controller.attachParent(query);
  const adopted = controller.useParentBounds();
  const state = controller.getState();
  if (capabilities.globalPositioning || capabilities.parentDiscovery || capabilities.externalParent
      || discovery !== null || attached !== null || adopted !== false || !parentPositionError) {
    throw new Error("Native Wayland compatibility contract changed unexpectedly.");
  }
  await setModel(window, {
    role: "info",
    scenario: "wayland-compat",
    result: "pass",
    title: "Native Wayland capability contract",
    subtitle: "Unsupported global parenting operations fail explicitly while Electron-owned policies remain available.",
    trace: ["getCapabilities(window, 'wayland-electron')", "findWindow() -> null", "configure(position: 'parent') -> error", "useParentBounds() -> false"],
    facts: {
      backend: capabilities.backend,
      globalPositioning: capabilities.globalPositioning,
      parentDiscovery: capabilities.parentDiscovery,
      externalParent: capabilities.externalParent,
      clickThrough: state.clickThrough,
      parentPositionRejected: Boolean(parentPositionError)
    },
    expectation: "The green diagnostic card reports PASS without claiming compositor-controlled global coordinates."
  });
  await settleRenderer(window);
  return reportFor("wayland-compat", "pass", capabilities.backend, window, {
    capabilities,
    discovery,
    attached,
    adopted,
    parentPositionError,
    state
  });
}

async function runCoordinatesDemo() {
  const display = screen.getPrimaryDisplay();
  const bounds = centeredBounds(display.bounds, 980, 640);
  const window = createWindow(bounds, { backgroundColor: "#101a29" });
  const selection = getBackendSelection(window, backend);
  const capabilities = getCapabilities(window, backend);
  const nativeRect = displayToNativeRect(display);
  const overlayRect = displayToOverlayRect(display, window, backend);
  await loadModel(window, {
    role: "info",
    scenario: "coordinates",
    result: "pass",
    title: "Backend + coordinate diagnostics",
    subtitle: "Pure inspection APIs resolve backend evidence, capabilities, and display coordinate spaces.",
    trace: [
      "getBackendSelection(window, backend)",
      "getCapabilities(window, backend)",
      "displayToNativeRect(display)",
      "displayToOverlayRect(display, window, backend)"
    ],
    facts: {
      backend: selection.backend,
      confidence: selection.confidence,
      evidence: selection.evidence,
      coordinateSpace: capabilities.boundsCoordinateSpace,
      nativeRect: rectLabel(nativeRect),
      overlayRect: rectLabel(overlayRect)
    },
    expectation: "The green diagnostic card reports a PASS and two concrete display rectangles at device scale factor 1."
  });
  window.show();
  await settleRenderer(window);
  return reportFor("coordinates", "pass", selection.backend, window, {
    selection,
    capabilities,
    nativeRect,
    overlayRect
  });
}

async function runLayerShellDemo() {
  if (process.platform !== "linux") {
    throw new Error("The layer-shell demo is Linux-only.");
  }
  if (!process.env.WAYLAND_DISPLAY) {
    throw new Error("The layer-shell demo requires a native Wayland connection.");
  }
  const output = option("output", process.env.LAYER_SHELL_OUTPUT);
  if (!output) throw new Error("--output or LAYER_SHELL_OUTPUT is required for the layer-shell demo.");
  const capabilities = getLayerShellCapabilities();
  const controller = await createLayerShellOverlay({
    placement: { type: "output", output, anchor: "fill" },
    namespace: "covas-electron-overlay-visual-demo",
    initializationTimeoutMs: 10_000
  });
  registerController(controller);
  const initialState = controller.getState();
  const window = trackWindow(new BrowserWindow({
    width: initialState.width,
    height: initialState.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      backgroundThrottling: false,
      offscreen: {
        useSharedTexture: option("shared-texture", "false") === "true",
        deviceScaleFactor: 1
      }
    }
  }));
  window.webContents.setFrameRate(30);
  controller.attachOffscreenWindow(window);
  let paintCount = 0;
  let captureNextPaint = false;
  let finalPaintChecksum = 0;
  window.webContents.on("paint", (_event, _dirtyRect, image) => {
    paintCount += 1;
    if (!captureNextPaint || image.isEmpty()) return;
    captureNextPaint = false;
    finalPaintChecksum = checksum(image.toBitmap({ scaleFactor: 1 }));
  });
  await loadModel(window, {
    role: "layer-shell",
    scenario: "layer-shell",
    result: "wait",
    title: "Native Wayland layer shell",
    subtitle: "Electron OSR is being committed into a compositor-owned overlay-layer surface.",
    trace: [
      "getLayerShellCapabilities()",
      "createLayerShellOverlay({ placement: output })",
      "new BrowserWindow({ offscreen: true })",
      "overlay.attachOffscreenWindow(window)",
      "overlay.getState()"
    ],
    facts: {
      output,
      configured: initialState.configured,
      size: `${initialState.width}x${initialState.height}`,
      transport: "waiting"
    },
    expectation: "Purple panels fill the selected output while the center aperture reveals the compositor background."
  });
  await waitUntil(() => {
    const state = controller.getState();
    if (state.error || state.renderError) throw new Error(state.error ?? state.renderError);
    return state.mapped && state.submittedFrameCount > 0 && state.frameCount > 0 ? state : null;
  }, "initial layer-shell frame");
  await delay(100);
  const beforeUpdate = controller.getState();
  const beforeUpdatePaintCount = paintCount;
  const state = controller.getState();
  captureNextPaint = true;
  await window.webContents.executeJavaScript(`globalThis.demoSetModel(${JSON.stringify({
    role: "layer-shell",
    scenario: "layer-shell",
    result: "pass",
    title: "Native Wayland layer shell",
    subtitle: "Electron OSR is committed into a compositor-owned overlay-layer surface.",
    trace: [
      "getLayerShellCapabilities()",
      "createLayerShellOverlay({ placement: output })",
      "new BrowserWindow({ offscreen: true })",
      "overlay.attachOffscreenWindow(window)",
      "overlay.getState()"
    ],
    facts: {
      output: state.output,
      mapped: state.mapped,
      sourceAttached: state.sourceAttached,
      size: `${state.width}x${state.height}`,
      transport: state.bufferBackend,
      dmabufAdvertised: state.dmabufAdvertised
    },
    expectation: "Purple panels fill the selected output while the center aperture reveals the compositor background."
  })})`);
  const verificationImage = await window.webContents.capturePage();
  if (!verificationImage.isEmpty()) {
    finalPaintChecksum = checksum(verificationImage.toBitmap({ scaleFactor: 1 }));
  }
  window.webContents.invalidate();
  await waitUntil(() => paintCount > beforeUpdatePaintCount, "final layer-shell renderer paint");
  const finalState = await waitUntil(() => {
    const current = controller.getState();
    if (current.error || current.renderError) throw new Error(current.error ?? current.renderError);
    const finalSubmissionCommitted = current.frameCount > beforeUpdate.frameCount
      && current.submittedFrameCount > beforeUpdate.submittedFrameCount;
    const finalBufferReleased = current.bufferReleaseCount > beforeUpdate.bufferReleaseCount;
    const transportMatches = current.bufferBackend === "linux-dmabuf"
      ? current.dmabufSubmittedFrameCount > beforeUpdate.dmabufSubmittedFrameCount
      : finalPaintChecksum !== 0 && current.lastFrameChecksum === finalPaintChecksum;
    return finalSubmissionCommitted && finalBufferReleased && transportMatches ? current : null;
  }, "committed and released layer-shell verification frame");
  return reportFor("layer-shell", "pass", capabilities.backend, null, {
    capabilities,
    state: finalState,
    output
  });
}

async function runUnsupportedDemo(id, backendName, reason, facts) {
  const display = screen.getPrimaryDisplay();
  const window = createWindow(centeredBounds(display.bounds, 980, 640), { backgroundColor: "#101a29" });
  await loadModel(window, {
    role: "info",
    scenario: id,
    result: "unsupported",
    title: `${id[0].toUpperCase()}${id.slice(1)} API unavailable`,
    subtitle: reason,
    trace: ["getCapabilities(window, backend)", "capability gate", "render deterministic unsupported result"],
    facts: { backend: backendName, ...facts },
    expectation: "The screenshot contains an orange UNSUPPORTED badge and names the unavailable backend capability."
  });
  window.show();
  await settleRenderer(window);
  return reportFor(id, "unsupported", backendName, window, { reason, ...facts });
}

function createWindow(bounds, overrides = {}) {
  return trackWindow(new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    resizable: false,
    backgroundColor: "#101a29",
    webPreferences: { backgroundThrottling: false },
    ...overrides
  }));
}

function createOverlayWindow(bounds) {
  return createWindow(bounds, {
    transparent: true,
    backgroundColor: "#00000000",
    focusable: false,
    hasShadow: false
  });
}

function trackWindow(window) {
  windows.add(window);
  window.on("closed", () => windows.delete(window));
  return window;
}

function registerController(controller) {
  let closed = false;
  cleanups.push(() => {
    if (closed) return;
    closed = true;
    controller.close();
  });
}

async function loadModel(window, model) {
  const url = new URL("./renderer.html", import.meta.url);
  url.searchParams.set("model", JSON.stringify(model));
  await window.loadURL(url.href);
}

async function setModel(window, model) {
  await window.webContents.executeJavaScript(`globalThis.demoSetModel(${JSON.stringify(model)})`);
}

async function settleRenderer(window) {
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
  await delay(50);
}

function stageModel(id, title) {
  return {
    role: "stage",
    scenario: id,
    result: "reference",
    title,
    subtitle: "Opaque compositor reference. Grid continuity should be visible through transparent overlay regions."
  };
}

function waitingOverlayModel(id, title) {
  return {
    role: "overlay",
    scenario: id,
    result: "wait",
    title,
    subtitle: "The renderer is ready; native policy will be applied after the compositor maps this surface.",
    trace: ["map BrowserWindow", "configure native policy", "render observed state"],
    facts: { phase: "waiting for native policy" },
    expectation: "Automation waits for the final PASS model before capturing the compositor."
  };
}

function reportFor(id, result, backendName, primaryWindow, details) {
  return jsonSafe({
    schemaVersion: 1,
    scenario: id,
    result,
    backend: backendName,
    captureTarget: "desktop",
    readiness: "renderer-and-native-requests-complete",
    primaryWindowTitle: primaryWindow
      ? `electron-overlay demo | ${id} | ${result.toUpperCase()}`
      : null,
    details
  });
}

async function announceReady(report) {
  if (report.primaryWindowTitle) {
    const primary = [...windows].at(-1);
    if (primary && !primary.isDestroyed()) primary.setTitle(report.primaryWindowTitle);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (readyFile) {
    const temporaryFile = `${readyFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, serialized, "utf8");
    await rename(temporaryFile, readyFile);
  }
  process.stdout.write(`ELECTRON_OVERLAY_DEMO_READY ${JSON.stringify(report)}\n`);
  if (exitAfterReady > 0) setTimeout(() => app.quit(), exitAfterReady);
}

async function waitUntil(probe, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function centeredBounds(displayBounds, desiredWidth, desiredHeight) {
  const width = Math.min(desiredWidth, Math.max(640, displayBounds.width - 80));
  const height = Math.min(desiredHeight, Math.max(480, displayBounds.height - 80));
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

function rectLabel(rect) {
  return `${rect.x},${rect.y} / ${rect.width}x${rect.height}`;
}

function sameRect(left, right) {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function escapeSwayRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function focusSwayTitle(title) {
  if (process.env.SWAYSOCK) {
    execFileSync("swaymsg", [`[title="^${escapeSwayRegex(title)}$"]`, "focus"], { stdio: "ignore" });
  }
}

async function spawnTarget({ scenario: targetScenario, title, bounds }) {
  const directory = mkdtempSync(join(tmpdir(), "electron-overlay-target-"));
  const readyPath = join(directory, "ready.json");
  const commandPath = join(directory, "command.json");
  const statePath = join(directory, "state.json");
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--ozone-platform=x11",
    fileURLToPath(new URL("./target.mjs", import.meta.url)),
    `--scenario=${targetScenario}`,
    `--target-title=${title}`,
    `--x=${bounds.x}`,
    `--y=${bounds.y}`,
    `--width=${bounds.width}`,
    `--height=${bounds.height}`,
    `--ready-file=${readyPath}`,
    `--command-file=${commandPath}`,
    `--state-file=${statePath}`
  ], { env: childEnvironment, stdio: "inherit" });
  const target = {
    child,
    commandPath,
    statePath,
    directory,
    sequence: 0,
    processId: child.pid,
    ready: null,
    stopped: false
  };
  const close = () => {
    if (!target.stopped && child.exitCode === null) child.kill("SIGTERM");
    target.stopped = true;
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  };
  cleanups.push(close);
  child.once("exit", () => { target.stopped = true; });
  child.once("error", (error) => { console.error(`Target process failed: ${error.message}`); });
  target.ready = await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`Target process exited with status ${child.exitCode}.`);
    return readJsonIfPresent(readyPath);
  }, `${targetScenario} target readiness`);
  if (target.ready.processId !== child.pid) throw new Error("Target readiness PID does not match the child process.");
  return target;
}

async function commandTarget(target, action, details = {}) {
  if (target.stopped || target.child.exitCode !== null) throw new Error("Target process is not running.");
  target.sequence += 1;
  const command = { schemaVersion: 1, sequence: target.sequence, action, ...details };
  const temporary = `${target.commandPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(command, null, 2)}\n`, "utf8");
  await rename(temporary, target.commandPath);
  return waitUntil(async () => {
    const state = await readJsonIfPresent(target.statePath);
    return state?.sequence === target.sequence ? state : null;
  }, `target action ${action}`);
}

async function stopTarget(target) {
  if (target.stopped || target.child.exitCode !== null) return;
  await commandTarget(target, "close");
  await waitUntil(() => target.child.exitCode !== null ? true : null, "target process exit");
  target.stopped = true;
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function numberOption(name, fallback) {
  const value = option(name, String(fallback));
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative number.`);
  return parsed;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function checksum(buffer) {
  let value = 2166136261;
  for (const byte of buffer) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value;
}

function cleanup() {
  for (const close of cleanups.splice(0).reverse()) {
    try { close(); } catch (error) { console.error(error); }
  }
}
