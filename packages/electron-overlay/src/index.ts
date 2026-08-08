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
  renderingMode: "test-pattern";
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
  output?: string;
  error?: string;
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
  renderingMode: "test-pattern"
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
  constructor(private readonly controller: NativeLayerShellController) {}

  getState(): LayerShellOverlayState { return { ...this.controller.getState() }; }
  getCapabilities(): LayerShellCapabilities { return getLayerShellCapabilities(); }
  close(): void { this.controller.close(); }
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

class NativeAddonBackend implements OverlayBackend {
  readonly capabilities: OverlayCapabilities;

  constructor(kind: "win32" | "macos" | "x11") {
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
    return loadAddon().configure(nativeWindowHandle, nativeOptions);
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
