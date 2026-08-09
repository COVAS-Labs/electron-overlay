import type { BrowserWindow } from "electron";

import type { LayerShellOverlayController } from "../packages/electron-overlay/src/index.js";

declare const overlay: LayerShellOverlayController;
declare const window: BrowserWindow;

overlay.attachOffscreenWindow(window);
