# @covas-labs/electron-overlay

A policy controller for transparent Electron overlay windows on Linux, Windows, and macOS. Linux X11/XWayland uses the native addon; native Wayland uses an Electron compatibility backend with an explicit, smaller capability set.

## Supported platforms

The published prebuilt packages support Linux x64, Windows x64, and macOS arm64. Other platform and architecture combinations do not currently have a released native addon. Linux x64 supports X11/XWayland and the Electron compatibility backend for native Wayland.

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
