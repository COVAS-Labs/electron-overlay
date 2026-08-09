import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { LayerShellOverlayController } from "../packages/electron-overlay/dist/index.js";

function createNativeController() {
  const submissions = [];
  const dmabufSubmissions = [];
  const releasedDmabufs = [];
  const activeDmabufs = new Set();
  let closed = false;
  const controller = {
    submissions,
    dmabufSubmissions,
    compositorClosed: false,
    acceptFrames: true,
    acceptDmabuf: true,
    dmabufUsable: true,
    submitFrame(frame, width, height) {
      submissions.push({ frame: Buffer.from(frame), width, height });
      return controller.acceptFrames;
    },
    submitDmabuf(info, submissionId) {
      dmabufSubmissions.push({ info, submissionId });
      if (controller.dmabufError) throw controller.dmabufError;
      if (controller.acceptDmabuf) activeDmabufs.add(submissionId);
      return controller.acceptDmabuf;
    },
    releaseDmabuf(submissionId) {
      activeDmabufs.delete(submissionId);
      releasedDmabufs.push(submissionId);
    },
    takeReleasedDmabufs() { return releasedDmabufs.splice(0); },
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
        bufferBackend: controller.dmabufUsable ? "linux-dmabuf" : "wl_shm",
        dmabufAdvertised: true,
        dmabufUsable: controller.dmabufUsable,
        dmabufServerVersion: 4,
        dmabufBoundVersion: 3,
        dmabufSubmittedFrameCount: dmabufSubmissions.length,
        dmabufImportFailureCount: 0,
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
  const captures = [];
  let destroyed = false;
  const webContents = {
    isOffscreen: () => true,
    isDestroyed: () => destroyed,
    invalidate() { invalidations += 1; },
    capturePage(rect) {
      captures.push(rect);
      return Promise.resolve(image(rect.width, rect.height));
    },
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events)
  };
  return {
    events,
    captures,
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

function sharedTexture(overrides = {}, release = undefined) {
  let releases = 0;
  const payload = {
    textureInfo: {
      codedSize: { width: 4, height: 2 },
      pixelFormat: "bgra",
      handle: {
        nativePixmap: {
          modifier: "72057594037927935",
          planes: [{ fd: 17, stride: 16, offset: 0, size: 32 }]
        }
      },
      ...overrides
    },
    release() {
      releases += 1;
      release?.();
    },
    releases: () => releases
  };
  return payload;
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
  const capturePage = window.webContents.capturePage;
  delete window.webContents.capturePage;
  assert.throws(() => overlay.attachOffscreenWindow(window), /capturePage/);
  window.webContents.capturePage = capturePage;

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

test("prefers DMA-BUF, owns its metadata snapshot, and releases only on native completion", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  overlay.attachOffscreenWindow(window);

  const texture = sharedTexture();
  const sourceInfo = texture.textureInfo;
  const sourcePixmap = sourceInfo.handle.nativePixmap;
  const bitmap = image(4, 2);
  window.events.emit("paint", { texture }, { x: 0, y: 0, width: 4, height: 2 }, bitmap);

  assert.equal(native.dmabufSubmissions.length, 1);
  assert.equal(native.submissions.length, 0);
  assert.equal(texture.releases(), 0);
  assert.ok(Number.isSafeInteger(native.dmabufSubmissions[0].submissionId));
  assert.ok(native.dmabufSubmissions[0].submissionId > 0);
  assert.deepEqual(native.dmabufSubmissions[0].info, {
    codedSize: { width: 4, height: 2 },
    pixelFormat: "bgra",
    modifier: "72057594037927935",
    planes: [{ fd: 17, stride: 16, offset: 0, size: 32 }]
  });
  assert.notEqual(native.dmabufSubmissions[0].info.codedSize, sourceInfo.codedSize);
  assert.notEqual(native.dmabufSubmissions[0].info.planes, sourcePixmap.planes);
  assert.notEqual(native.dmabufSubmissions[0].info.planes[0], sourcePixmap.planes[0]);
  native.releaseDmabuf(native.dmabufSubmissions[0].submissionId);
  overlay.getState();
  assert.equal(texture.releases(), 1);
  overlay.close();
});

test("finds a shared texture in the third paint result and releases on rejection and exception", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  overlay.attachOffscreenWindow(window);

  native.acceptDmabuf = false;
  const rejected = sharedTexture();
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 }, rejected);
  assert.equal(rejected.releases(), 1);
  assert.equal(window.captures.length, 1);

  native.dmabufError = new Error("DMA-BUF exploded");
  const throwing = sharedTexture();
  window.events.emit("paint", { texture: throwing }, { x: 0, y: 0, width: 4, height: 2 });
  assert.equal(throwing.releases(), 1);
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.ok(native.submissions.length >= 1);
  overlay.close();
});

test("releases a delivered texture exactly once after the overlay is closed", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  overlay.attachOffscreenWindow(window);
  const paint = window.events.listeners("paint")[0];
  overlay.close();

  const texture = sharedTexture();
  paint({ texture }, { x: 0, y: 0, width: 4, height: 2 });
  assert.equal(texture.releases(), 1);
  assert.equal(native.dmabufSubmissions.length, 0);
});

test("uses direct NativeImage fallback and coalesces capture fallback with lifecycle cleanup", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  const pendingCaptures = [];
  window.webContents.capturePage = (rect) => {
    window.captures.push(rect);
    return new Promise((resolve) => pendingCaptures.push({ rect, resolve }));
  };
  overlay.attachOffscreenWindow(window);

  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 }, image(4, 2));
  assert.equal(native.submissions.length, 1);
  assert.equal(window.captures.length, 0);

  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  assert.equal(window.captures.length, 1);
  assert.deepEqual(window.captures[0], { x: 0, y: 0, width: 4, height: 2 });

  pendingCaptures[0].resolve(image(4, 2));
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(window.captures.length, 2);
  overlay.close();
  pendingCaptures[1].resolve(image(4, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.submissions.length, 2);
  assert.equal(window.events.listenerCount("paint"), 0);
});

test("starts a software capture when native DMA-BUF support is disabled asynchronously", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  overlay.attachOffscreenWindow(window);

  native.dmabufUsable = false;
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(window.captures.length, 1);
  assert.deepEqual(window.captures[0], { x: 0, y: 0, width: 4, height: 2 });
  overlay.close();
});

test("drains dropped DMA-BUF mailbox IDs and ignores duplicate or unknown completions", () => {
  const native = createNativeController();
  const submitDmabuf = native.submitDmabuf.bind(native);
  native.submitDmabuf = (info, submissionId) => {
    if (native.dmabufSubmissions.length === 1) {
      native.releaseDmabuf(native.dmabufSubmissions[0].submissionId);
    }
    return submitDmabuf(info, submissionId);
  };
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  overlay.attachOffscreenWindow(window);

  const first = sharedTexture();
  const second = sharedTexture();
  window.events.emit("paint", { texture: first }, { x: 0, y: 0, width: 4, height: 2 });
  window.events.emit("paint", { texture: second }, { x: 0, y: 0, width: 4, height: 2 });
  assert.equal(first.releases(), 1);
  assert.equal(second.releases(), 0);

  const secondId = native.dmabufSubmissions[1].submissionId;
  native.releaseDmabuf(999_999);
  native.releaseDmabuf(secondId);
  native.releaseDmabuf(secondId);
  overlay.getState();
  assert.equal(second.releases(), 1);
  overlay.close();
});

test("closes native before releasing outstanding DMA-BUF leases", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  let nativeWasClosedAtRelease = false;
  const texture = sharedTexture({}, () => {
    nativeWasClosedAtRelease = native.getState().closed;
  });
  overlay.attachOffscreenWindow(window);
  window.events.emit("paint", { texture }, { x: 0, y: 0, width: 4, height: 2 });

  overlay.close();
  assert.equal(texture.releases(), 1);
  assert.equal(nativeWasClosedAtRelease, true);
});

test("rebound callbacks only release unaccepted textures and cannot close the new source", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const oldWindow = createOffscreenWindow();
  overlay.attachOffscreenWindow(oldWindow);
  const oldPaint = oldWindow.events.listeners("paint")[0];
  const oldDestroyed = oldWindow.events.listeners("destroyed")[0];
  const accepted = sharedTexture();
  oldPaint({ texture: accepted }, { x: 0, y: 0, width: 4, height: 2 });

  const newWindow = createOffscreenWindow();
  overlay.attachOffscreenWindow(newWindow);
  const late = sharedTexture();
  oldPaint({ texture: late }, { x: 0, y: 0, width: 4, height: 2 });
  oldDestroyed();
  assert.equal(late.releases(), 1);
  assert.equal(accepted.releases(), 0);
  assert.equal(native.dmabufSubmissions.length, 1);
  assert.equal(native.getState().closed, false);
  assert.equal(overlay.getState().sourceAttached, true);

  native.releaseDmabuf(native.dmabufSubmissions[0].submissionId);
  overlay.getState();
  assert.equal(accepted.releases(), 1);
  overlay.close();
});

test("paces failed captures and permits a later coalesced retry", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  window.webContents.capturePage = (rect) => {
    window.captures.push(rect);
    return Promise.reject(new Error("capture failed"));
  };
  overlay.attachOffscreenWindow(window);

  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.captures.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(window.captures.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(window.captures.length, 2);
  overlay.close();
});

test("continuous unusable paints do not starve an in-flight SHM capture", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  let resolveCapture;
  window.webContents.capturePage = (rect) => {
    window.captures.push(rect);
    return new Promise((resolve) => { resolveCapture = resolve; });
  };
  overlay.attachOffscreenWindow(window);

  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  for (let index = 0; index < 10; index += 1) {
    window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  }
  resolveCapture(image(4, 2));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(native.submissions.length, 1);
  overlay.close();
});

test("discards a stale capture after a newer paint generation submits", async () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  let resolveCapture;
  window.webContents.capturePage = (rect) => {
    window.captures.push(rect);
    return new Promise((resolve) => { resolveCapture = resolve; });
  };
  overlay.attachOffscreenWindow(window);

  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 });
  window.events.emit("paint", {}, { x: 0, y: 0, width: 4, height: 2 }, image(4, 2));
  resolveCapture(image(4, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.submissions.length, 1);
  overlay.close();
});

test("records release exceptions without releasing a completed lease twice", () => {
  const native = createNativeController();
  const overlay = new LayerShellOverlayController(native);
  const window = createOffscreenWindow();
  const texture = sharedTexture({}, () => { throw new Error("release failed"); });
  overlay.attachOffscreenWindow(window);
  window.events.emit("paint", { texture }, { x: 0, y: 0, width: 4, height: 2 });
  native.releaseDmabuf(native.dmabufSubmissions[0].submissionId);

  assert.doesNotThrow(() => overlay.getState());
  assert.equal(texture.releases(), 1);
  assert.match(overlay.getState().renderError, /release failed/);
  assert.equal(texture.releases(), 1);
  overlay.close();
});
