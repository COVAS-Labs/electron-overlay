# electron-overlay

Window policy for Electron overlays on Linux, Windows, and macOS. The public package is `@covas-labs/electron-overlay`; the native addon remains a separate workspace package, following the same layout as `electron-vr`.

Electron creates the transparent Chromium surface. Win32, macOS, and X11 use the native addon for window policy. Native Wayland uses a separate compatibility backend that applies the supported policy through Electron without assuming access to global windows, coordinates, or X11 handles.

## Development

```sh
npm install
npm run build
npm run build:addon
npm run test
```

For Electron's Node ABI:

```sh
npm run rebuild:electron
```

Linux build dependencies are the X11 and XFixes development packages, for example `libx11-dev libxfixes-dev` on Debian/Ubuntu. Windows uses the Win32 SDK, and macOS links AppKit and ApplicationServices.

## Linux backends

The package treats X11 and native Wayland as different backend families. To use the full X11 backend, select X11 before `app.ready` and configure with `backend: "x11"`:

```js
app.commandLine.appendSwitch('ozone-platform', 'x11');
```

This also works through XWayland and provides external window discovery, transient parenting, global positioning, and fullscreen stacking policy.

When Electron runs as a native Wayland client, pass the `BrowserWindow` itself to `configure()`. The `wayland-electron` backend uses Electron for click-through and best-effort always-on-top behavior. It cannot discover or parent arbitrary external windows, use global positioning, or guarantee placement above fullscreen content. These limitations are exposed through `overlay.getCapabilities()`.

A future layer-shell backend will own a separate native Wayland surface. It is intentionally not implemented by trying to change the role of Chromium's existing `xdg_toplevel`.

See [`packages/electron-overlay/README.md`](packages/electron-overlay/README.md) for API usage.
