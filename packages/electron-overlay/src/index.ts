import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowQuery {
  title: string;
  match?: "exact" | "contains";
  className?: string;
}

export interface ParentInfo {
  xid: bigint;
  title: string;
  className: string;
  bounds: NativeRect;
}

export interface OverlayOptions {
  bounds?: NativeRect;
  parent?: WindowQuery;
  position: "bounds" | "parent";
  clickThrough?: boolean;
  alwaysOnTop?: boolean;
  preserveCompositing?: boolean;
  allWorkspaces?: boolean;
}

export interface ParentAttachOptions {
  reposition?: boolean;
}

export interface OverlayState {
  overlayXid: bigint;
  parent: ParentInfo | null;
  bounds: NativeRect;
  position: "bounds" | "parent";
  clickThrough: boolean;
  alwaysOnTop: boolean;
  preserveCompositing: boolean;
  allWorkspaces: boolean;
  closed: boolean;
}

export interface ElectronDisplayLike {
  bounds: NativeRect;
  nativeOrigin?: { x: number; y: number };
  scaleFactor: number;
}

interface NativeController {
  attachParent(query: WindowQuery, options?: ParentAttachOptions): ParentInfo | null;
  detachParent(): void;
  setBounds(bounds: NativeRect): void;
  useParentBounds(): boolean;
  setClickThrough(enabled: boolean): void;
  setAlwaysOnTop(enabled: boolean): void;
  reapply(): void;
  getState(): OverlayState;
  close(): void;
}

interface NativeAddon {
  configure(handle: Buffer, options: OverlayOptions): NativeController;
  findWindow(query: WindowQuery): ParentInfo | null;
}

const PREBUILT_PACKAGES: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: {
    arm64: "@covas-labs/electron-overlay-prebuilt-darwin-arm64",
    x64: "@covas-labs/electron-overlay-prebuilt-darwin-x64"
  },
  linux: {
    arm64: "@covas-labs/electron-overlay-prebuilt-linux-arm64",
    x64: "@covas-labs/electron-overlay-prebuilt-linux-x64"
  },
  win32: {
    arm64: "@covas-labs/electron-overlay-prebuilt-win32-arm64",
    x64: "@covas-labs/electron-overlay-prebuilt-win32-x64"
  }
};
let addon: NativeAddon | null = null;

function loadAddon(): NativeAddon {
  if (addon) {
    return addon;
  }
  const require = createRequire(import.meta.url);
  const applicationRequire = createRequire(resolve(process.cwd(), "package.json"));
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const localPath = resolve(currentDir, "..", "..", "native-addon", "build", "Release", "x11_overlay.node");
  const prebuiltPackage = PREBUILT_PACKAGES[process.platform]?.[process.arch];

  try {
    addon = require(localPath) as NativeAddon;
  } catch (localError) {
    if (!prebuiltPackage) {
      throw new Error(`No native overlay prebuilt is available for ${process.platform}-${process.arch}. Local addon: ${String(localError)}`);
    }
    try {
      addon = require(prebuiltPackage) as NativeAddon;
    } catch (packageError) {
      try {
        addon = applicationRequire(prebuiltPackage) as NativeAddon;
      } catch (applicationError) {
        throw new Error(
          `Failed to load the native overlay addon for ${process.platform}-${process.arch}. Local: ${String(localError)}; package: ${String(packageError)}; application: ${String(applicationError)}`
        );
      }
    }
  }
  return addon;
}

function validateRect(rect: NativeRect): NativeRect {
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(rect[key])) {
      throw new TypeError(`bounds.${key} must be a finite number.`);
    }
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RangeError("bounds width and height must be positive.");
  }
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

export function displayToNativeRect(display: ElectronDisplayLike): NativeRect {
  if (process.platform === "darwin") {
    return validateRect(display.bounds);
  }
  const origin = display.nativeOrigin ?? {
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor)
  };
  return validateRect({
    x: origin.x,
    y: origin.y,
    width: display.bounds.width * display.scaleFactor,
    height: display.bounds.height * display.scaleFactor
  });
}

export class OverlayController {
  constructor(private readonly native: NativeController) {}

  attachParent(query: WindowQuery, options: ParentAttachOptions = {}): ParentInfo | null {
    return this.native.attachParent(query, options);
  }
  detachParent(): void { this.native.detachParent(); }
  setBounds(bounds: NativeRect): void { this.native.setBounds(validateRect(bounds)); }
  useParentBounds(): boolean { return this.native.useParentBounds(); }
  setClickThrough(enabled: boolean): void { this.native.setClickThrough(enabled); }
  setAlwaysOnTop(enabled: boolean): void { this.native.setAlwaysOnTop(enabled); }
  reapply(): void { this.native.reapply(); }
  getState(): OverlayState { return this.native.getState(); }
  close(): void { this.native.close(); }
}

export { OverlayController as X11Overlay };

export function configure(nativeWindowHandle: Buffer, options: OverlayOptions): OverlayController {
  if (!Buffer.isBuffer(nativeWindowHandle) || nativeWindowHandle.length === 0) {
    throw new TypeError("nativeWindowHandle must be the Buffer returned by BrowserWindow.getNativeWindowHandle().");
  }
  if (options.position === "bounds") {
    if (!options.bounds) {
      throw new TypeError("options.bounds is required when position is 'bounds'.");
    }
    options = { ...options, bounds: validateRect(options.bounds) };
  } else if (options.position !== "parent") {
    throw new RangeError("options.position must be 'bounds' or 'parent'.");
  }
  return new OverlayController(loadAddon().configure(nativeWindowHandle, options));
}

export function findWindow(query: WindowQuery): ParentInfo | null {
  return loadAddon().findWindow(query);
}
