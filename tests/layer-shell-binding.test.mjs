import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { LayerShellOverlayController } from "../packages/electron-overlay/dist/index.js";

function createNativeController() {
  const submissions = [];
  let closed = false;
  const controller = {
    submissions,
    compositorClosed: false,
    acceptFrames: true,
    submitFrame(frame, width, height) {
      submissions.push({ frame: Buffer.from(frame), width, height });
      return controller.acceptFrames;
    },
    getState() {
      return {
        configured: true,
        mapped: true,
        closed,
        compositorClosed: controller.compositorClosed,
        width: 4,
        height: 2,
        frameCount: 1,
        bufferReleaseCount: 0,
        submittedFrameCount: submissions.length,
        droppedFrameCount: 0,
        lastFrameChecksum: 0,
        output: "TEST-1"
      };
    },
    close() { closed = true; }
  };
  return controller;
}

function createOffscreenWindow() {
  const events = new EventEmitter();
  const sizes = [];
  let contentSize = [1, 1];
  let invalidations = 0;
  let destroyed = false;
  const webContents = {
    isOffscreen: () => true,
    isDestroyed: () => destroyed,
    invalidate() { invalidations += 1; },
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events)
  };
  return {
    events,
    sizes,
    webContents,
    invalidations: () => invalidations,
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; events.emit("destroyed"); },
    getContentSize: () => contentSize,
    setContentSize(width, height) {
      contentSize = [width, height];
      sizes.push(contentSize);
    }
  };
}

function image(width, height, fill = 0x40) {
  const bitmap = Buffer.alloc(width * height * 4, fill);
  return {
    bitmap,
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap
  };
}

test("binds Electron offscreen paint frames to native wl_shm submission", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();

  overlay.attachOffscreenWindow(window);
  assert.deepEqual(window.sizes, [[4, 2]]);
  assert.equal(window.invalidations(), 1);
  assert.equal(overlay.getState().sourceAttached, true);

  const frame = image(4, 2);
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 }, frame);
  assert.equal(native.submissions.length, 1);
  assert.deepEqual(native.submissions[0], { frame: frame.bitmap, width: 4, height: 2 });

  window.events.emit("paint", {}, { x: 0, y: 0, width: 2, height: 1 }, image(2, 1));
  assert.deepEqual(window.sizes, [[4, 2]]);
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(window.invalidations(), 2);
  assert.equal(native.submissions.length, 1);

  overlay.close();
  assert.equal(overlay.getState().sourceAttached, false);
  assert.equal(window.events.listenerCount("paint"), 0);
  assert.equal(native.getState().closed, true);
});

test("rejects non-offscreen windows and closes when the source is destroyed", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  window.webContents.isOffscreen = () => false;
  assert.throws(() => overlay.attachOffscreenWindow(window), /offscreen enabled/);

  window.webContents.isOffscreen = () => true;
  overlay.attachOffscreenWindow(window);
  window.destroy();
  assert.equal(native.getState().closed, true);
  assert.equal(window.events.listenerCount("paint"), 0);
});

test("detaches on terminal native rejection and rolls back failed attachment", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const failingWindow = createOffscreenWindow();
  failingWindow.setContentSize = () => { throw new Error("resize failed"); };
  assert.throws(() => overlay.attachOffscreenWindow(failingWindow), /resize failed/);
  assert.equal(failingWindow.events.listenerCount("paint"), 0);

  const window = createOffscreenWindow();
  overlay.attachOffscreenWindow(window);
  native.acceptFrames = false;
  native.compositorClosed = true;
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 }, image(4, 2));
  assert.equal(native.getState().closed, true);
  assert.equal(window.events.listenerCount("paint"), 0);
  assert.match(overlay.getState().renderError, /compositor closed/);

  const initialNative = createNativeController();
  const initialOverlay = new LayerShellOverlayController(initialNative);
  const initialWindow = createOffscreenWindow();
  initialWindow.webContents.invalidate = () => {
    initialNative.acceptFrames = false;
    initialNative.compositorClosed = true;
    initialWindow.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 }, image(4, 2));
  };
  assert.throws(() => initialOverlay.attachOffscreenWindow(initialWindow), /compositor closed/);
  assert.equal(initialWindow.events.listenerCount("paint"), 0);
  assert.equal(initialOverlay.getState().sourceAttached, false);
});

test("retries a compositor resize when BrowserWindow constraints reject it", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  let invalidations = 0;
  window.setContentSize = (width, height) => { window.sizes.push([width, height]); };
  window.webContents.invalidate = () => {
    invalidations += 1;
    setImmediate(() => {
      window.events.emit("paint", {}, { x: 0, y: 0, width: 1, height: 1 }, image(1, 1));
    });
  };

  overlay.attachOffscreenWindow(window);
  await new Promise((resolve) => setTimeout(resolve, 125));

  assert.ok(window.sizes.length >= 2);
  assert.ok(invalidations >= 2);
  assert.ok(invalidations < 5);
  assert.deepEqual(window.sizes[0], [4, 2]);
  assert.deepEqual(window.sizes[1], [4, 2]);
  overlay.close();
});
