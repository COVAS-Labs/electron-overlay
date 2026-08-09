# @covas-labs/electron-overlay

A policy controller for transparent Electron overlay windows on Linux, Windows, and macOS. Linux X11/XWayland uses the native addon; native Wayland supports an Electron compatibility backend and an experimental separately owned layer-shell surface.

## Supported platforms

The published prebuilt packages support Linux x64, Windows x64, and macOS arm64. Other platform and architecture combinations do not currently have a released native addon. The Linux package contains separate X11 and layer-shell modules so Wayland libraries are loaded only when the experimental backend is requested.

## Usage

Create the `BrowserWindow` without bypassing the window manager:

```js
import { BrowserWindow, screen } from 'electron';
import {
  configure,
  displayToNativeRect,
  displayToOverlayRect
} from '@covas-labs/electron-overlay';

const display = screen.getPrimaryDisplay();
const backend = 'auto';
const window = new BrowserWindow({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  focusable: false,
  show: false,
  webPreferences: { preload: overlayPreloadPath }
});

const overlay = configure(window, {
  backend,
  bounds: displayToOverlayRect(display, window, backend),
  parent: { title: 'Elite - Dangerous', match: 'contains' },
  position: 'bounds',
  clickThrough: true,
  alwaysOnTop: true,
  preserveCompositing: true
});

await window.loadURL(overlayUrl);
overlay.reapply();
window.showInactive();
overlay.reapply();

window.on('closed', () => overlay.close());
```

Passing the `BrowserWindow` lets `auto` select `wayland-electron` in a native Wayland session. The legacy buffer form remains supported for native backends:

```js
const overlay = configure(window.getNativeWindowHandle(), {
  bounds: displayToNativeRect(display),
  position: 'bounds'
});
```

Buffer targets always select the platform addon in `auto` mode for backward compatibility. If the application passes a `BrowserWindow` and forces X11 with `app.commandLine.appendSwitch('ozone-platform', 'x11')`, use `backend: 'x11'` because appended Electron switches are not visible through Node's `process.argv`.

`getBackendSelection(window, backend)` reports the selected backend, whether the result is certain or inferred, and the command-line or environment evidence used. Session environment detection remains an inference; applications that explicitly choose Electron's Ozone platform should pass the matching backend.

For one-time parent sizing on a backend that reports `externalParent`, configure with `position: 'parent'`. If the target is not running yet, attach it later without moving the overlay:

```js
overlay.attachParent(
  { title: 'Elite - Dangerous', match: 'contains' },
  { reposition: false }
);
```

`attachParent()` returns `null` when no mapped matching client exists. Matching defaults to case-insensitive `contains`; active matches win, followed by the topmost matching client.

On `wayland-electron`, `position: 'parent'` is rejected, `attachParent()` returns `null`, and `useParentBounds()` returns `false`. A parent query cannot identify an arbitrary external Wayland surface without compositor cooperation.

## Capabilities

```ts
const capabilities = overlay.getCapabilities();
```

The result reports:

```ts
interface OverlayCapabilities {
  backend:
    | 'win32'
    | 'macos'
    | 'x11'
    | 'wayland-electron';
  clickThrough: boolean;
  aboveFullscreen: boolean;
  externalParent: boolean;
  parentDiscovery: boolean;
  globalPositioning: boolean;
  boundsCoordinateSpace: 'native-pixels' | 'electron-screen';
}
```

`getCapabilities(window, backend)` can inspect a backend before creating an overlay. `displayToOverlayRect(display, window, backend)` returns bounds in the same backend and coordinate space that `configure(window, { backend })` will use. Wayland Electron bounds use Electron screen coordinates; their global `x` and `y` are advisory because the compositor controls top-level placement.

The compatibility backend reports `aboveFullscreen: false`, `externalParent: false`, `parentDiscovery: false`, and `globalPositioning: false`. It does not emulate X11's `WM_TRANSIENT_FOR`, restacking, or EWMH policy.

## Experimental layer-shell surface

`createLayerShellOverlay()` owns a new native Wayland surface. Bind a separately created offscreen `BrowserWindow` after the compositor has configured the output size. Enable shared textures to prefer direct Linux DMA-BUF import; paced `capturePage()` readback automatically feeds the `wl_shm` fallback when DMA-BUF is unavailable or rejected:

```ts
import { BrowserWindow } from 'electron';
import {
  createLayerShellOverlay,
  getLayerShellCapabilities
} from '@covas-labs/electron-overlay';

console.log(getLayerShellCapabilities());

const overlay = await createLayerShellOverlay({
  placement: {
    type: 'output',
    output: 'DP-1',
    anchor: 'fill'
  },
  namespace: 'my-overlay',
  initializationTimeoutMs: 5000
});

const window = new BrowserWindow({
  width: overlay.getState().width,
  height: overlay.getState().height,
  show: false,
  transparent: true,
  webPreferences: {
    offscreen: {
      useSharedTexture: true,
      deviceScaleFactor: 1
    }
  }
});

overlay.attachOffscreenWindow(window);
await window.loadURL(overlayUrl);

console.log(overlay.getState());
overlay.close();
window.destroy();
```

The surface uses the overlay layer, exclusive zone `-1`, keyboard interactivity `none`, and an empty input region. The preferred path consumes Electron shared-texture metadata from `paint`, duplicates its DMA-BUF descriptor, negotiates the exact DRM format/modifier advertised by `zwp_linux_dmabuf_v1`, and imports it as a transient `wl_buffer`. The Electron texture remains leased until that buffer is released, dropped, rejected, or closed. Only `rgba` and `bgra` single-plane textures are currently imported.

The fallback path copies complete premultiplied BGRA frames into double-buffered `WL_SHM_FORMAT_ARGB8888` storage. If shared-texture rendering does not provide a bitmap, capture readback is paced and coalesced before SHM submission. `attachOffscreenWindow()` sizes the renderer to the compositor configuration, requests an initial frame, follows later size changes, removes listeners on close or rebind, and closes the layer surface if the renderer is destroyed. The native thread retains only the newest uncommitted frame for either transport. The controller never destroys the caller's BrowserWindow.

`overlay.getState()` reports the most recently committed `bufferBackend`, DMA-BUF advertisement and usability, negotiated protocol versions, submitted DMA-BUF frames, import failures, and the latest nonfatal import failure. Successful SHM fallback is not reported as a terminal overlay error.

The API fails explicitly on non-Linux systems, when the Linux layer-shell binary is unavailable, when the compositor does not advertise `zwlr_layer_shell_v1`, or when the required output name is absent. Initialization defaults to a five-second deadline. Use `wayland-electron` as the application-level fallback.

Layer-shell controller methods:

```ts
attachOffscreenWindow(window): void
getState(): LayerShellOverlayState
getCapabilities(): LayerShellCapabilities
close(): void
```

## Controller API

```ts
attachParent(query, { reposition?: false }): ParentInfo | null
detachParent(): void
setBounds(nativePixelBounds): void
useParentBounds(): boolean
setClickThrough(enabled): void
setAlwaysOnTop(enabled): void
reapply(): void
getState(): OverlayState
getCapabilities(): OverlayCapabilities
close(): void
```

On Linux, the addon sets `WM_TRANSIENT_FOR`, utility/state/focus hints, and an empty XFixes input region. On Windows it uses an owned tool window with no-activate, transparent hit testing, and topmost placement. On macOS it uses `NSWindow` mouse ignoring, levels, spaces behavior, and Core Graphics discovery.

macOS does not expose a supported cross-process transient-owner relationship. `attachParent()` therefore records the matching window and can adopt its geometry, while `alwaysOnTop` supplies stacking. Window-title discovery may require Screen Recording permission on recent macOS versions.
