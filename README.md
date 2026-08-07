# electron-overlay

Native window policy for Electron overlays on Linux, Windows, and macOS. The public package is `@covas-labs/electron-overlay`; the native addon remains a separate workspace package, following the same layout as `electron-vr`.

Electron creates the transparent Chromium surface, while the addon owns platform window placement, parent/owner policy where available, no-focus behavior, click-through input, stacking, and reapplication.

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

## Runtime requirements

On Linux, select Electron's X11 backend before `app.ready`:

```js
app.commandLine.appendSwitch('ozone-platform', 'x11');
```

This also applies on Wayland desktops where Electron and the target application run through XWayland. Rectangles use native desktop pixels on Linux/Windows and Electron screen points on macOS; `displayToNativeRect()` handles that distinction.

See [`packages/electron-overlay/README.md`](packages/electron-overlay/README.md) for API usage.
