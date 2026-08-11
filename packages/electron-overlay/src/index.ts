import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
  backend?: OverlayBackendPreference;
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

export type OverlayBackendKind =
  | "win32"
  | "macos"
  | "x11"
  | "wayland-electron";

export type OverlayBackendPreference = "auto" | "x11" | "wayland-electron";

export interface OverlayBackendSelection {
  backend: OverlayBackendKind;
  source: "explicit" | "native-handle" | "ozone-argument" | "environment" | "platform-default";
  confidence: "certain" | "inferred";
  evidence: string;
}

export interface OverlayCapabilities {
  backend: OverlayBackendKind;
  clickThrough: boolean;
  aboveFullscreen: boolean;
  externalParent: boolean;
  parentDiscovery: boolean;
  globalPositioning: boolean;
  boundsCoordinateSpace: "native-pixels" | "electron-screen";
}

export interface LayerShellCapabilities {
  backend: "wayland-layer-shell";
  clickThrough: true;
  aboveFullscreen: true;
  externalParent: false;
  parentDiscovery: false;
  globalPositioning: false;
  outputPlacement: boolean;
  parentPlacement: boolean;
  keyboardInteractivity: "none";
  renderingMode: "electron-offscreen";
  preferredBufferTransport: "linux-dmabuf";
  bufferTransports: readonly ["linux-dmabuf", "wl_shm"];
  shmFallback: true;
}

export interface OutputPlacement {
  type: "output";
  output: string;
  anchor: "fill";
}

export interface LayerShellOverlayOptions {
  placement: OutputPlacement;
  namespace?: string;
  initializationTimeoutMs?: number;
}

export interface LayerShellOverlayState {
  configured: boolean;
  mapped: boolean;
  closed: boolean;
  compositorClosed: boolean;
  width: number;
  height: number;
  frameCount: number;
  bufferReleaseCount: number;
  submittedFrameCount: number;
  droppedFrameCount: number;
  lastFrameChecksum: number;
  bufferBackend: "wl_shm" | "linux-dmabuf";
  dmabufAdvertised: boolean;
  dmabufUsable: boolean;
  dmabufServerVersion: number;
  dmabufBoundVersion: number;
  dmabufSubmittedFrameCount: number;
  dmabufImportFailureCount: number;
  dmabufLastFailure?: string;
  sourceAttached?: boolean;
  renderError?: string;
  output?: string;
  error?: string;
}

export interface LinuxTexturePlane {
  fd: number;
  stride: number;
  offset: number;
  size: number;
}

export interface LinuxTextureInfo {
  codedSize: { width: number; height: number };
  pixelFormat: "rgba" | "bgra";
  modifier: string;
  planes: LinuxTexturePlane[];
}

export interface ElectronLinuxNativePixmapLike {
  planes: LinuxTexturePlane[];
  modifier: string;
  supportsZeroCopyWebGpuImport?: boolean;
}

export interface ElectronSharedTextureInfoLike {
  codedSize?: { width: number; height: number };
  pixelFormat?: "rgba" | "bgra" | "rgbaf16";
  handle?: { nativePixmap?: ElectronLinuxNativePixmapLike };
  modifier?: string;
  planes?: LinuxTexturePlane[];
}

export interface ElectronSharedTexturePayloadLike {
  textureInfo: ElectronSharedTextureInfoLike;
  release(): void;
}

export interface ElectronSharedTexturePaintEventLike {
  texture?: ElectronSharedTexturePayloadLike;
}

export interface ElectronOffscreenNativeImageLike {
  isEmpty(): boolean;
  getSize(scaleFactor?: number): { width: number; height: number };
  toBitmap(options?: { scaleFactor?: number }): Buffer;
}

export type ElectronOffscreenPaintListener = (
  event: ElectronSharedTexturePaintEventLike,
  dirtyRect: NativeRect,
  image: ElectronOffscreenNativeImageLike
) => void;

export interface ElectronOffscreenWebContentsLike {
  isOffscreen(): boolean;
  isDestroyed(): boolean;
  invalidate(): void;
  capturePage(rect?: NativeRect): Promise<ElectronOffscreenNativeImageLike>;
  on(event: "paint", listener: ElectronOffscreenPaintListener): unknown;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "paint", listener: ElectronOffscreenPaintListener): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export interface ElectronOffscreenBrowserWindowLike {
  readonly webContents: ElectronOffscreenWebContentsLike;
  isDestroyed?(): boolean;
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
}

export interface ElectronBrowserWindowLike {
  getNativeWindowHandle(): Buffer;
  getBounds?(): NativeRect;
  setBounds(bounds: NativeRect): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean): void;
  setVisibleOnAllWorkspaces?(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }
  ): void;
  isDestroyed?(): boolean;
}

interface ElectronScreenLike {
  screenToDipRect(window: null, rect: NativeRect): NativeRect;
}

interface ControllerBackend {
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
  configure(handle: Buffer, options: OverlayOptions): ControllerBackend;
  findWindow(query: WindowQuery): ParentInfo | null;
}

type SupportedBackendKind = OverlayBackendKind;

interface OverlayBackend {
  readonly capabilities: OverlayCapabilities;
  configure(target: Buffer | ElectronBrowserWindowLike, options: OverlayOptions): ControllerBackend;
  findWindow(query: WindowQuery): ParentInfo | null;
}

interface NativeLayerShellController {
  initialize(): Promise<void>;
  submitFrame(frame: Buffer, width: number, height: number): boolean;
  submitDmabuf(info: LinuxTextureInfo, submissionId: number): boolean;
  takeReleasedDmabufs(): number[];
  getState(): LayerShellOverlayState;
  close(): void;
}

interface NativeLayerShellAddon {
  createLayerShellOverlay(options: {
    output?: string;
    namespace?: string;
    initializationTimeoutMs?: number;
  }): NativeLayerShellController;
}

export const PREBUILT_PACKAGES: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: {
    arm64: "@covas-labs/electron-overlay-prebuilt-darwin-arm64"
  },
  linux: {
    x64: "@covas-labs/electron-overlay-prebuilt-linux-x64"
  },
  win32: {
    x64: "@covas-labs/electron-overlay-prebuilt-win32-x64"
  }
};
let addon: NativeAddon | null = null;
let layerShellAddon: NativeLayerShellAddon | null = null;

const CAPABILITIES: Record<SupportedBackendKind, OverlayCapabilities> = {
  win32: {
    backend: "win32",
    clickThrough: true,
    aboveFullscreen: true,
    externalParent: true,
    parentDiscovery: true,
    globalPositioning: true,
    boundsCoordinateSpace: "native-pixels"
  },
  macos: {
    backend: "macos",
    clickThrough: true,
    aboveFullscreen: true,
    externalParent: false,
    parentDiscovery: true,
    globalPositioning: true,
    boundsCoordinateSpace: "electron-screen"
  },
  x11: {
    backend: "x11",
    clickThrough: true,
    aboveFullscreen: true,
    externalParent: true,
    parentDiscovery: true,
    globalPositioning: true,
    boundsCoordinateSpace: "native-pixels"
  },
  "wayland-electron": {
    backend: "wayland-electron",
    clickThrough: true,
    aboveFullscreen: false,
    externalParent: false,
    parentDiscovery: false,
    globalPositioning: false,
    boundsCoordinateSpace: "electron-screen"
  }
};

const LAYER_SHELL_CAPABILITIES: LayerShellCapabilities = {
  backend: "wayland-layer-shell",
  clickThrough: true,
  aboveFullscreen: true,
  externalParent: false,
  parentDiscovery: false,
  globalPositioning: false,
  outputPlacement: true,
  parentPlacement: false,
  keyboardInteractivity: "none",
  renderingMode: "electron-offscreen",
  preferredBufferTransport: "linux-dmabuf",
  bufferTransports: ["linux-dmabuf", "wl_shm"],
  shmFallback: true
};

function nativeBackendKind(): "win32" | "macos" | "x11" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "macos";
  return "x11";
}

function detectLinuxBackend(): OverlayBackendSelection {
  const ozoneArgument = process.argv.find((argument) => argument.startsWith("--ozone-platform="));
  const ozonePlatform = ozoneArgument?.slice("--ozone-platform=".length);
  if (ozonePlatform === "x11" || ozonePlatform === "wayland") {
    return {
      backend: ozonePlatform === "wayland" ? "wayland-electron" : "x11",
      source: "ozone-argument",
      confidence: "certain",
      evidence: ozoneArgument!
    };
  }
  const ozoneEnvironment = process.env.OZONE_PLATFORM ?? process.env.ELECTRON_OZONE_PLATFORM_HINT;
  if (ozoneEnvironment === "x11" || ozoneEnvironment === "wayland") {
    return {
      backend: ozoneEnvironment === "wayland" ? "wayland-electron" : "x11",
      source: "environment",
      confidence: "inferred",
      evidence: `Ozone environment hint is ${ozoneEnvironment}`
    };
  }
  if (process.env.XDG_SESSION_TYPE === "wayland" && process.env.WAYLAND_DISPLAY) {
    return {
      backend: "wayland-electron",
      source: "environment",
      confidence: "inferred",
      evidence: "XDG_SESSION_TYPE=wayland and WAYLAND_DISPLAY is set"
    };
  }
  return {
    backend: "x11",
    source: "platform-default",
    confidence: "inferred",
    evidence: "No explicit native-Wayland evidence was available"
  };
}

export function getBackendSelection(
  target?: Buffer | ElectronBrowserWindowLike,
  preference: OverlayBackendPreference = "auto"
): OverlayBackendSelection {
  if (preference !== "auto") {
    return {
      backend: preference,
      source: "explicit",
      confidence: "certain",
      evidence: `backend=${preference}`
    };
  }
  if (Buffer.isBuffer(target) || process.platform !== "linux") {
    const backend = nativeBackendKind();
    return {
      backend,
      source: Buffer.isBuffer(target) ? "native-handle" : "platform-default",
      confidence: "certain",
      evidence: Buffer.isBuffer(target)
        ? "Buffer targets retain the platform native backend"
        : `process.platform=${process.platform}`
    };
  }
  return detectLinuxBackend();
}

function resolveBackend(
  preference: OverlayBackendPreference,
  target?: Buffer | ElectronBrowserWindowLike
): SupportedBackendKind {
  return getBackendSelection(target, preference).backend;
}

export function getCapabilities(
  target?: Buffer | ElectronBrowserWindowLike,
  backend: OverlayBackendPreference = "auto"
): OverlayCapabilities {
  return { ...CAPABILITIES[resolveBackend(backend, target)] };
}

export function getLayerShellCapabilities(): LayerShellCapabilities {
  return { ...LAYER_SHELL_CAPABILITIES };
}

function loadLayerShellAddon(): NativeLayerShellAddon {
  if (layerShellAddon) return layerShellAddon;
  if (process.platform !== "linux") {
    throw new Error("The wayland-layer-shell backend is only available on Linux.");
  }
  const require = createRequire(import.meta.url);
  const applicationRequire = createRequire(resolve(process.cwd(), "package.json"));
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(currentDir, "..");
  const nativeWorkspaceDir = resolve(packageDir, "..", "native-addon");
  const localPath = resolve(nativeWorkspaceDir, "build", "Release", "wayland_layer_shell.node");
  const prebuiltPackage = PREBUILT_PACKAGES.linux?.[process.arch];
  const errors: string[] = [];

  if (prebuiltPackage) {
    for (const packageRequire of [require, applicationRequire]) {
      try {
        const binary = packageRequire.resolve(`${prebuiltPackage}/wayland_layer_shell.node`);
        layerShellAddon = packageRequire(binary) as NativeLayerShellAddon;
        break;
      } catch (error) {
        errors.push(String(error));
      }
    }
  }
  if (!layerShellAddon && existsSync(localPath)) {
    try {
      layerShellAddon = require(localPath) as NativeLayerShellAddon;
    } catch (error) {
      errors.push(String(error));
    }
  }
  if (!layerShellAddon) {
    throw new Error(`Failed to load the native layer-shell addon for linux-${process.arch}. ${errors.join("; ")}`);
  }
  return layerShellAddon;
}

function loadAddon(): NativeAddon {
  if (addon) {
    return addon;
  }
  const require = createRequire(import.meta.url);
  const applicationRequire = createRequire(resolve(process.cwd(), "package.json"));
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(currentDir, "..");
  const workspacePackagesDir = resolve(packageDir, "..");
  const nativeWorkspaceDir = resolve(workspacePackagesDir, "native-addon");
  const localPath = resolve(nativeWorkspaceDir, "build", "Release", "x11_overlay.node");
  const prebuiltPackage = PREBUILT_PACKAGES[process.platform]?.[process.arch];
  const errors: string[] = [];

  if (prebuiltPackage) {
    try {
      addon = require(prebuiltPackage) as NativeAddon;
    } catch (packageError) {
      errors.push(`package: ${String(packageError)}`);
      try {
        addon = applicationRequire(prebuiltPackage) as NativeAddon;
      } catch (applicationError) {
        errors.push(`application: ${String(applicationError)}`);
      }
    }
  }

  const isWorkspaceDevelopment = basename(packageDir) === "electron-overlay"
    && basename(workspacePackagesDir) === "packages"
    && existsSync(resolve(nativeWorkspaceDir, "package.json"));
  if (!addon && isWorkspaceDevelopment) {
    try {
      addon = require(localPath) as NativeAddon;
    } catch (localError) {
      errors.push(`workspace: ${String(localError)}`);
    }
  }

  if (!addon) {
    if (!prebuiltPackage) {
      throw new Error(`No native overlay prebuilt is available for ${process.platform}-${process.arch}.`);
    }
    throw new Error(
      `Failed to load the native overlay addon for ${process.platform}-${process.arch}. ${errors.join("; ")}`
    );
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

function isNativeImageLike(value: unknown): value is ElectronOffscreenNativeImageLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ElectronOffscreenNativeImageLike>;
  return typeof candidate.isEmpty === "function"
    && typeof candidate.getSize === "function"
    && typeof candidate.toBitmap === "function";
}

function isSharedTexturePayload(value: unknown): value is ElectronSharedTexturePayloadLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ElectronSharedTexturePayloadLike>;
  return typeof candidate.release === "function"
    && !!candidate.textureInfo
    && typeof candidate.textureInfo === "object";
}

function snapshotLinuxTextureInfo(
  texture: ElectronSharedTexturePayloadLike
): LinuxTextureInfo | null {
  const textureInfo = texture.textureInfo;
  const nativePixmap = textureInfo.handle?.nativePixmap;
  const codedSize = textureInfo.codedSize;
  const pixelFormat = textureInfo.pixelFormat;
  const modifier = nativePixmap?.modifier ?? textureInfo.modifier;
  const planes = nativePixmap?.planes ?? textureInfo.planes;
  if (!codedSize || (pixelFormat !== "rgba" && pixelFormat !== "bgra")
      || typeof modifier !== "string" || !planes?.length) {
    return null;
  }
  return {
    codedSize: { width: codedSize.width, height: codedSize.height },
    pixelFormat,
    modifier,
    planes: planes.map(({ fd, stride, offset, size }) => ({ fd, stride, offset, size }))
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

export function displayToOverlayRect(
  display: ElectronDisplayLike,
  target: Buffer | ElectronBrowserWindowLike,
  backend: OverlayBackendPreference = "auto"
): NativeRect {
  return getCapabilities(target, backend).boundsCoordinateSpace === "electron-screen"
    ? validateRect(display.bounds)
    : displayToNativeRect(display);
}

export class OverlayController {
  constructor(
    private readonly controller: ControllerBackend,
    private readonly capabilities: OverlayCapabilities = CAPABILITIES[nativeBackendKind()]
  ) {}

  attachParent(query: WindowQuery, options: ParentAttachOptions = {}): ParentInfo | null {
    return this.controller.attachParent(query, options);
  }
  detachParent(): void { this.controller.detachParent(); }
  setBounds(bounds: NativeRect): void { this.controller.setBounds(validateRect(bounds)); }
  useParentBounds(): boolean { return this.controller.useParentBounds(); }
  setClickThrough(enabled: boolean): void { this.controller.setClickThrough(enabled); }
  setAlwaysOnTop(enabled: boolean): void { this.controller.setAlwaysOnTop(enabled); }
  reapply(): void { this.controller.reapply(); }
  getState(): OverlayState { return this.controller.getState(); }
  getCapabilities(): OverlayCapabilities { return { ...this.capabilities }; }
  close(): void { this.controller.close(); }
}

export class LayerShellOverlayController {
  private detachSource?: () => void;
  private sourceAttached = false;
  private renderError?: string;
  private closed = false;
  private sourceGeneration = 0;
  private nextSubmissionId = 1;
  private readonly dmabufLeases = new Map<number, ElectronSharedTexturePayloadLike>();
  private leaseMonitor?: NodeJS.Timeout;

  constructor(private readonly controller: NativeLayerShellController) {}

  private releaseTexture(texture: ElectronSharedTexturePayloadLike): void {
    try {
      texture.release();
    } catch (error) {
      this.renderError ??= String(error);
    }
  }

  private allocateSubmissionId(): number {
    const start = this.nextSubmissionId;
    do {
      const submissionId = this.nextSubmissionId;
      this.nextSubmissionId = submissionId === Number.MAX_SAFE_INTEGER ? 1 : submissionId + 1;
      if (!this.dmabufLeases.has(submissionId)) return submissionId;
    } while (this.nextSubmissionId !== start);
    throw new Error("No DMA-BUF submission IDs are available.");
  }

  private stopLeaseMonitor(): void {
    if (this.leaseMonitor) clearInterval(this.leaseMonitor);
    this.leaseMonitor = undefined;
  }

  private drainReleasedDmabufs(): void {
    let releasedIds: number[];
    try {
      releasedIds = this.controller.takeReleasedDmabufs();
    } catch (error) {
      this.renderError ??= String(error);
      return;
    }
    for (const submissionId of releasedIds) {
      const texture = this.dmabufLeases.get(submissionId);
      if (!texture) continue;
      this.dmabufLeases.delete(submissionId);
      this.releaseTexture(texture);
    }
    if (this.dmabufLeases.size === 0) this.stopLeaseMonitor();
  }

  private retainDmabuf(
    submissionId: number,
    texture: ElectronSharedTexturePayloadLike
  ): void {
    this.dmabufLeases.set(submissionId, texture);
    if (this.leaseMonitor) return;
    this.leaseMonitor = setInterval(() => this.drainReleasedDmabufs(), 25);
    this.leaseMonitor.unref?.();
  }

  attachOffscreenWindow(window: ElectronOffscreenBrowserWindowLike): void {
    if (this.closed) throw new Error("Layer-shell overlay controller is closed.");
    if (!window || typeof window !== "object" || !window.webContents) {
      throw new TypeError("attachOffscreenWindow requires an Electron offscreen BrowserWindow.");
    }
    const webContents = window.webContents;
    const requiredWindowMethods = ["getContentSize", "setContentSize"] as const;
    const requiredWebContentsMethods = [
      "isOffscreen",
      "isDestroyed",
      "invalidate",
      "capturePage",
      "on",
      "removeListener"
    ] as const;
    if (requiredWindowMethods.some((method) => typeof window[method] !== "function")
        || requiredWebContentsMethods.some((method) => typeof webContents[method] !== "function")) {
      throw new TypeError(
        "attachOffscreenWindow requires Electron offscreen BrowserWindow methods, including webContents.capturePage()."
      );
    }
    if (window.isDestroyed?.() || webContents.isDestroyed()) {
      throw new Error("Electron offscreen BrowserWindow is destroyed.");
    }
    if (!webContents.isOffscreen()) {
      throw new Error("BrowserWindow must be created with webPreferences.offscreen enabled.");
    }

    this.detachSource?.();
    const attachmentGeneration = ++this.sourceGeneration;
    let sizeMonitor: NodeJS.Timeout | undefined;
    let captureTimer: NodeJS.Timeout | undefined;
    let invalidatePending = false;
    let invalidating = false;
    let sourceActive = true;
    let captureInFlight = false;
    let pendingCaptureGeneration: number | undefined;
    let latestPaintGeneration = 0;
    let lastSubmittedGeneration = 0;
    let lastCaptureStartedAt = 0;
    let dmabufFallbackActive = false;
    const nextPaintGeneration = () => {
      latestPaintGeneration += 1;
      return latestPaintGeneration;
    };
    const terminalError = (state: LayerShellOverlayState): string | undefined => {
      if (state.error) return state.error;
      if (state.compositorClosed) return "The Wayland compositor closed the layer-shell surface.";
      if (state.closed) return "The layer-shell overlay controller is closed.";
      return undefined;
    };
    const resizeSource = (forceInvalidate = false, allowInvalidate = true) => {
      const state = this.controller.getState();
      const error = terminalError(state);
      if (error) throw new Error(error);
      const [sourceWidth, sourceHeight] = window.getContentSize();
      if (state.width !== sourceWidth || state.height !== sourceHeight) {
        window.setContentSize(state.width, state.height);
        invalidatePending = true;
      }
      if (forceInvalidate) invalidatePending = true;
      if (allowInvalidate && invalidatePending && !invalidating) {
        invalidatePending = false;
        invalidating = true;
        try {
          webContents.invalidate();
        } finally {
          invalidating = false;
        }
      }
    };

    const submitImage = (
      image: ElectronOffscreenNativeImageLike,
      generation: number
    ): "submitted" | "retry" | "resize" | "terminal" => {
      if (this.closed || !sourceActive) return "terminal";
      if (image.isEmpty()) return "retry";
      try {
        const state = this.controller.getState();
        const error = terminalError(state);
        if (error) {
          this.renderError = error;
          this.close();
          return "terminal";
        }
        const size = image.getSize(1);
        if (size.width !== state.width || size.height !== state.height) {
          resizeSource(true, false);
          return "resize";
        }
        const bitmap = image.toBitmap({ scaleFactor: 1 });
        if (bitmap.length !== size.width * size.height * 4) {
          this.renderError = "Electron offscreen bitmap length does not match its dimensions.";
          return "retry";
        }
        if (!this.controller.submitFrame(bitmap, size.width, size.height)) {
          const rejectedState = this.controller.getState();
          const rejectedError = terminalError(rejectedState);
          if (rejectedError) {
            this.renderError = rejectedError;
            this.close();
            return "terminal";
          }
          return "retry";
        }
        this.renderError = undefined;
        lastSubmittedGeneration = Math.max(lastSubmittedGeneration, generation);
        return "submitted";
      } catch (error) {
        this.renderError = String(error);
        return this.closed ? "terminal" : "retry";
      }
    };

    const startCaptureFallback = () => {
      captureTimer = undefined;
      if (!sourceActive || this.closed || captureInFlight
          || pendingCaptureGeneration === undefined) return;
      const captureGeneration = pendingCaptureGeneration;
      pendingCaptureGeneration = undefined;
      let state: LayerShellOverlayState;
      try {
        state = this.controller.getState();
        const error = terminalError(state);
        if (error) {
          this.renderError = error;
          this.close();
          return;
        }
      } catch (error) {
        this.renderError = String(error);
        return;
      }

      captureInFlight = true;
      lastCaptureStartedAt = Date.now();
      let capture: Promise<ElectronOffscreenNativeImageLike>;
      try {
        capture = webContents.capturePage({ x: 0, y: 0, width: state.width, height: state.height });
      } catch {
        captureInFlight = false;
        pendingCaptureGeneration = captureGeneration;
        scheduleCaptureFallback(captureGeneration);
        return;
      }
      void capture
        .then((image) => {
          if (!sourceActive || this.closed || attachmentGeneration !== this.sourceGeneration
              || captureGeneration < lastSubmittedGeneration) return;
          if (submitImage(image, captureGeneration) === "retry") {
            pendingCaptureGeneration = Math.max(captureGeneration, latestPaintGeneration);
          }
        })
        .catch(() => {
          if (!sourceActive || this.closed) return;
          pendingCaptureGeneration = Math.max(captureGeneration, latestPaintGeneration);
          try {
            const terminal = terminalError(this.controller.getState());
            if (!terminal) return;
            this.renderError = terminal;
            this.close();
          } catch (stateError) {
            this.renderError = String(stateError);
            this.close();
          }
        })
        .finally(() => {
          captureInFlight = false;
          if (sourceActive && !this.closed && pendingCaptureGeneration !== undefined) {
            scheduleCaptureFallback(pendingCaptureGeneration);
          }
        });
    };

    const scheduleCaptureFallback = (generation: number) => {
      if (!sourceActive || this.closed) return;
      pendingCaptureGeneration = generation;
      if (captureInFlight || captureTimer) return;
      const delay = Math.max(0, 100 - (Date.now() - lastCaptureStartedAt));
      if (delay === 0) {
        startCaptureFallback();
        return;
      }
      captureTimer = setTimeout(startCaptureFallback, delay);
      captureTimer.unref?.();
    };

    const useSoftwareFallback = (
      image: ElectronOffscreenNativeImageLike | undefined,
      generation: number
    ) => {
      dmabufFallbackActive = true;
      if (!image || submitImage(image, generation) === "retry") scheduleCaptureFallback(generation);
    };

    const paint = (
      event: ElectronSharedTexturePaintEventLike,
      _dirtyRect: NativeRect,
      result: unknown
    ) => {
      const texture = isSharedTexturePayload(event?.texture)
        ? event.texture
        : isSharedTexturePayload(result)
          ? result
          : null;
      const image = isNativeImageLike(result) ? result : undefined;
      let releaseTexture = texture !== null;
      try {
        if (this.closed || !sourceActive || attachmentGeneration !== this.sourceGeneration) return;
        const paintGeneration = nextPaintGeneration();
        this.drainReleasedDmabufs();
        if (!texture) {
          if (!image || submitImage(image, paintGeneration) === "retry") {
            scheduleCaptureFallback(paintGeneration);
          }
          return;
        }

        const info = snapshotLinuxTextureInfo(texture);
        const state = this.controller.getState();
        const error = terminalError(state);
        if (error) {
          this.renderError = error;
          this.close();
          return;
        }
        if (!info || state.dmabufUsable === false) {
          useSoftwareFallback(image, paintGeneration);
          return;
        }
        if (info.codedSize.width !== state.width || info.codedSize.height !== state.height) {
          resizeSource(true, false);
          useSoftwareFallback(image, paintGeneration);
          return;
        }

        const submissionId = this.allocateSubmissionId();
        let submitted = false;
        try {
          submitted = this.controller.submitDmabuf(info, submissionId);
        } catch (submitError) {
          this.renderError = String(submitError);
        }
        if (!submitted) {
          const rejectedState = this.controller.getState();
          const rejectedError = terminalError(rejectedState);
          if (rejectedError) {
            this.renderError = rejectedError;
            this.close();
            return;
          }
          useSoftwareFallback(image, paintGeneration);
          return;
        }

        this.retainDmabuf(submissionId, texture);
        releaseTexture = false;
        lastSubmittedGeneration = Math.max(lastSubmittedGeneration, paintGeneration);
        this.drainReleasedDmabufs();
        const submittedState = this.controller.getState();
        const submittedError = terminalError(submittedState);
        if (submittedError) {
          this.renderError = submittedError;
          this.close();
          return;
        }
        if (submittedState.dmabufUsable === false) {
          useSoftwareFallback(image, paintGeneration);
          return;
        }
        dmabufFallbackActive = false;
        this.renderError = undefined;
      } catch (error) {
        this.renderError = String(error);
        if (!this.closed && sourceActive) {
          useSoftwareFallback(image, latestPaintGeneration || nextPaintGeneration());
        }
      } finally {
        if (texture && releaseTexture) this.releaseTexture(texture);
      }
    };
    const destroyed = () => {
      if (sourceActive && attachmentGeneration === this.sourceGeneration) this.close();
    };
    const monitorSize = () => {
      if (this.closed || !sourceActive || attachmentGeneration !== this.sourceGeneration) return;
      try {
        this.drainReleasedDmabufs();
        resizeSource();
        const state = this.controller.getState();
        if (state.dmabufUsable === false && !dmabufFallbackActive) {
          dmabufFallbackActive = true;
          scheduleCaptureFallback(nextPaintGeneration());
        }
      } catch (error) {
        this.renderError = String(error);
        this.close();
      }
    };
    webContents.on("paint", paint);
    webContents.on("destroyed", destroyed);
    const detachNewSource = () => {
      sourceActive = false;
      pendingCaptureGeneration = undefined;
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = undefined;
      if (sizeMonitor) clearInterval(sizeMonitor);
      webContents.removeListener("paint", paint);
      webContents.removeListener("destroyed", destroyed);
      if (this.detachSource === detachNewSource) {
        this.detachSource = undefined;
        this.sourceAttached = false;
      }
    };
    this.detachSource = detachNewSource;
    this.sourceAttached = true;
    try {
      resizeSource(true);
      if (this.closed) {
        throw new Error(this.renderError ?? "Layer-shell overlay controller closed while attaching its source.");
      }
      sizeMonitor = setInterval(monitorSize, 100);
      sizeMonitor.unref?.();
    } catch (error) {
      detachNewSource();
      throw error;
    }
  }

  getState(): LayerShellOverlayState {
    this.drainReleasedDmabufs();
    return {
      ...this.controller.getState(),
      sourceAttached: this.sourceAttached,
      ...(this.renderError && { renderError: this.renderError })
    };
  }
  getCapabilities(): LayerShellCapabilities { return getLayerShellCapabilities(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sourceGeneration += 1;
    this.detachSource?.();
    let closeError: unknown;
    try {
      this.controller.close();
    } catch (error) {
      closeError = error;
    }
    this.drainReleasedDmabufs();
    this.stopLeaseMonitor();
    for (const [submissionId, texture] of this.dmabufLeases) {
      this.dmabufLeases.delete(submissionId);
      this.releaseTexture(texture);
    }
    if (closeError) throw closeError;
  }
}

export async function createLayerShellOverlay(
  options: LayerShellOverlayOptions
): Promise<LayerShellOverlayController> {
  if (!options || !options.placement) {
    throw new TypeError("placement is required for the layer-shell backend.");
  }
  const placement = options.placement;
  if (placement.type !== "output" || placement.anchor !== "fill") {
    throw new RangeError("The experimental layer-shell backend currently supports only fill-output placement.");
  }
  if (typeof placement.output !== "string" || !placement.output.trim()) {
    throw new TypeError("placement.output must be a non-empty Wayland output name.");
  }
  if (options.namespace !== undefined && (typeof options.namespace !== "string" || !options.namespace.trim())) {
    throw new TypeError("namespace must be a non-empty string.");
  }
  if (options.initializationTimeoutMs !== undefined
      && (!Number.isFinite(options.initializationTimeoutMs)
        || options.initializationTimeoutMs < 100
        || options.initializationTimeoutMs > 60_000)) {
    throw new RangeError("initializationTimeoutMs must be between 100 and 60000.");
  }
  const controller = loadLayerShellAddon().createLayerShellOverlay({
    output: placement.output,
    ...(options.namespace && { namespace: options.namespace }),
    ...(options.initializationTimeoutMs !== undefined && {
      initializationTimeoutMs: Math.round(options.initializationTimeoutMs)
    })
  });
  await controller.initialize();
  return new LayerShellOverlayController(controller);
}

export { OverlayController as X11Overlay };

class WaylandElectronController implements ControllerBackend {
  private state: OverlayState;

  constructor(
    private readonly window: ElectronBrowserWindowLike,
    options: OverlayOptions
  ) {
    if (options.position === "parent") {
      throw new Error("The wayland-electron backend does not support parent positioning. Use output/display bounds instead.");
    }
    this.state = {
      overlayXid: 0n,
      parent: null,
      bounds: options.bounds!,
      position: options.position,
      clickThrough: options.clickThrough ?? true,
      alwaysOnTop: options.alwaysOnTop ?? true,
      preserveCompositing: options.preserveCompositing ?? true,
      allWorkspaces: options.allWorkspaces ?? false,
      closed: false
    };
    this.reapply();
  }

  private assertOpen(): void {
    if (this.state.closed) throw new Error("Overlay controller is closed.");
    if (this.window.isDestroyed?.()) throw new Error("Electron BrowserWindow is destroyed.");
  }

  attachParent(_query: WindowQuery, _options: ParentAttachOptions = {}): ParentInfo | null {
    this.assertOpen();
    return null;
  }
  detachParent(): void { this.assertOpen(); }
  setBounds(bounds: NativeRect): void {
    this.assertOpen();
    this.window.setBounds(bounds);
    this.state.bounds = this.window.getBounds ? validateRect(this.window.getBounds()) : bounds;
  }
  useParentBounds(): boolean {
    this.assertOpen();
    return false;
  }
  setClickThrough(enabled: boolean): void {
    this.assertOpen();
    this.window.setIgnoreMouseEvents(enabled);
    this.state.clickThrough = enabled;
  }
  setAlwaysOnTop(enabled: boolean): void {
    this.assertOpen();
    this.window.setAlwaysOnTop(enabled);
    this.state.alwaysOnTop = enabled;
  }
  reapply(): void {
    this.assertOpen();
    this.window.setBounds(this.state.bounds);
    if (this.window.getBounds) this.state.bounds = validateRect(this.window.getBounds());
    this.window.setIgnoreMouseEvents(this.state.clickThrough);
    this.window.setAlwaysOnTop(this.state.alwaysOnTop);
    this.window.setVisibleOnAllWorkspaces?.(this.state.allWorkspaces, {
      visibleOnFullScreen: true
    });
  }
  getState(): OverlayState {
    return {
      ...this.state,
      bounds: { ...this.state.bounds }
    };
  }
  close(): void { this.state.closed = true; }
}

class Win32ElectronController implements ControllerBackend {
  constructor(
    private readonly controller: ControllerBackend,
    private readonly window: ElectronBrowserWindowLike,
    initialBounds?: NativeRect
  ) {
    const state = this.controller.getState();
    if (initialBounds) this.applyElectronBounds(initialBounds);
    else if (state.position === "parent" && state.parent) this.applyElectronBounds(state.parent.bounds);
    this.window.setIgnoreMouseEvents(state.clickThrough);
  }

  private applyElectronBounds(bounds: NativeRect): void {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as { screen?: ElectronScreenLike };
    if (!electron.screen?.screenToDipRect) {
      throw new Error("The Win32 backend requires Electron's screen.screenToDipRect().");
    }
    this.window.setBounds(validateRect(electron.screen.screenToDipRect(null, bounds)));
  }

  attachParent(query: WindowQuery, options: ParentAttachOptions = {}): ParentInfo | null {
    const parent = this.controller.attachParent(query, options);
    if (parent && options.reposition) this.applyElectronBounds(parent.bounds);
    return parent;
  }
  detachParent(): void { this.controller.detachParent(); }
  setBounds(bounds: NativeRect): void {
    this.controller.setBounds(bounds);
    this.applyElectronBounds(bounds);
  }
  useParentBounds(): boolean {
    const adopted = this.controller.useParentBounds();
    const parent = this.controller.getState().parent;
    if (adopted && parent) this.applyElectronBounds(parent.bounds);
    return adopted;
  }
  setClickThrough(enabled: boolean): void {
    this.controller.setClickThrough(enabled);
    this.window.setIgnoreMouseEvents(enabled);
  }
  setAlwaysOnTop(enabled: boolean): void { this.controller.setAlwaysOnTop(enabled); }
  reapply(): void { this.controller.reapply(); }
  getState(): OverlayState { return this.controller.getState(); }
  close(): void { this.controller.close(); }
}

class NativeAddonBackend implements OverlayBackend {
  readonly capabilities: OverlayCapabilities;

  constructor(private readonly kind: "win32" | "macos" | "x11") {
    if (kind === "x11" && process.platform !== "linux") {
      throw new Error("The x11 backend is only available on Linux.");
    }
    this.capabilities = CAPABILITIES[kind];
  }

  configure(target: Buffer | ElectronBrowserWindowLike, options: OverlayOptions): ControllerBackend {
    const nativeWindowHandle = Buffer.isBuffer(target) ? target : target.getNativeWindowHandle();
    if (!Buffer.isBuffer(nativeWindowHandle) || nativeWindowHandle.length === 0) {
      throw new TypeError("BrowserWindow.getNativeWindowHandle() must return a non-empty Buffer.");
    }
    const nativeOptions = { ...options };
    delete nativeOptions.backend;
    const controller = loadAddon().configure(nativeWindowHandle, nativeOptions);
    return this.kind === "win32" && isBrowserWindowLike(target)
      ? new Win32ElectronController(controller, target, options.position === "bounds" ? options.bounds : undefined)
      : controller;
  }

  findWindow(query: WindowQuery): ParentInfo | null {
    return loadAddon().findWindow(query);
  }
}

class WaylandElectronBackend implements OverlayBackend {
  readonly capabilities = CAPABILITIES["wayland-electron"];

  configure(target: Buffer | ElectronBrowserWindowLike, options: OverlayOptions): ControllerBackend {
    if (!isBrowserWindowLike(target)) {
      throw new TypeError("The wayland-electron backend requires the Electron BrowserWindow, not its native handle Buffer.");
    }
    return new WaylandElectronController(target, options);
  }

  findWindow(_query: WindowQuery): ParentInfo | null {
    return null;
  }
}

function getBackend(kind: SupportedBackendKind): OverlayBackend {
  if (kind === "wayland-electron") return new WaylandElectronBackend();
  return new NativeAddonBackend(kind);
}

function isBrowserWindowLike(target: Buffer | ElectronBrowserWindowLike): target is ElectronBrowserWindowLike {
  return !Buffer.isBuffer(target)
    && typeof target === "object"
    && target !== null
    && typeof target.getNativeWindowHandle === "function"
    && typeof target.setBounds === "function"
    && typeof target.setIgnoreMouseEvents === "function"
    && typeof target.setAlwaysOnTop === "function";
}

export function configure(nativeWindowHandle: Buffer, options: OverlayOptions): OverlayController;
export function configure(window: ElectronBrowserWindowLike, options: OverlayOptions): OverlayController;
export function configure(target: Buffer | ElectronBrowserWindowLike, options: OverlayOptions): OverlayController;
export function configure(
  target: Buffer | ElectronBrowserWindowLike,
  options: OverlayOptions
): OverlayController {
  if (!Buffer.isBuffer(target) && !isBrowserWindowLike(target)) {
    throw new TypeError("target must be an Electron BrowserWindow or its getNativeWindowHandle() Buffer.");
  }
  if (Buffer.isBuffer(target) && target.length === 0) {
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
  const backend = getBackend(resolveBackend(options.backend ?? "auto", target));
  return new OverlayController(backend.configure(target, options), backend.capabilities);
}

export function findWindow(
  query: WindowQuery,
  options: { backend?: Exclude<OverlayBackendPreference, "auto"> } = {}
): ParentInfo | null {
  const backend = options.backend
    ? getBackend(resolveBackend(options.backend))
    : new NativeAddonBackend(nativeBackendKind());
  return backend.findWindow(query);
}
