# @covas-labs/electron-overlay

A native policy controller for transparent Electron overlay windows on Linux X11/XWayland, Windows, and macOS.

## Usage

Create the `BrowserWindow` without bypassing the window manager:

```js
import { BrowserWindow, screen } from 'electron';
import { configure, displayToNativeRect } from '@covas-labs/electron-overlay';

const display = screen.getPrimaryDisplay();
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

const overlay = configure(window.getNativeWindowHandle(), {
  bounds: displayToNativeRect(display),
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

For one-time parent sizing, configure with `position: 'parent'`. If the target is not running yet, attach it later without moving the overlay:

```js
overlay.attachParent(
  { title: 'Elite - Dangerous', match: 'contains' },
  { reposition: false }
);
```

`attachParent()` returns `null` when no mapped matching client exists. Matching defaults to case-insensitive `contains`; active matches win, followed by the topmost matching client.

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
close(): void
```

On Linux, the addon sets `WM_TRANSIENT_FOR`, utility/state/focus hints, and an empty XFixes input region. On Windows it uses an owned tool window with no-activate, transparent hit testing, and topmost placement. On macOS it uses `NSWindow` mouse ignoring, levels, spaces behavior, and Core Graphics discovery.

macOS does not expose a supported cross-process transient-owner relationship. `attachParent()` therefore records the matching window and can adopt its geometry, while `alwaysOnTop` supplies stacking. Window-title discovery may require Screen Recording permission on recent macOS versions.
