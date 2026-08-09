import type { BrowserWindow, OffscreenSharedTexture, WebContentsPaintEventParams } from "electron";

import type {
  ElectronSharedTexturePaintEventLike,
  ElectronSharedTexturePayloadLike,
  ElectronOffscreenPaintListener,
  LayerShellOverlayController,
  LinuxTextureInfo
} from "../packages/electron-overlay/src/index.js";

declare const overlay: LayerShellOverlayController;
declare const window: BrowserWindow;
declare const texture: OffscreenSharedTexture;
declare const paintEvent: WebContentsPaintEventParams;
declare const paintListener: ElectronOffscreenPaintListener;

overlay.attachOffscreenWindow(window);
window.webContents.on("paint", paintListener);
const payload: ElectronSharedTexturePayloadLike = texture;
const event: ElectronSharedTexturePaintEventLike = paintEvent;
const info: LinuxTextureInfo = {
  codedSize: { width: 1, height: 1 },
  pixelFormat: "bgra",
  modifier: "0",
  planes: [{ fd: 1, stride: 4, offset: 0, size: 4 }]
};
void payload;
void event;
void info;
const state = overlay.getState();
const backend: "wl_shm" | "linux-dmabuf" = state.bufferBackend;
const lastFailure: string | undefined = state.dmabufLastFailure;
void backend;
void lastFailure;
