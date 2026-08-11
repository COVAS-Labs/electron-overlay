# electron-overlay

Window policy for Electron overlays on Linux, Windows, and macOS. The public package is `@covas-labs/electron-overlay`; the native addon remains a separate workspace package, following the same layout as `electron-vr`.

Electron creates the transparent Chromium surface for the existing platform backends. Native Wayland also has an experimental, separately owned layer-shell surface that does not attempt to change Chromium's existing `xdg_toplevel` role.

## Supported release platforms

Prebuilt Electron addons are published for Linux x64, Windows x64, and macOS arm64. Other operating-system and architecture combinations are not currently released and fail with an explicit unsupported-prebuilt error. Linux x64 supports X11/XWayland, the Electron compatibility backend, and the experimental native layer-shell module.

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

Linux build dependencies are the Wayland, X11, and XFixes development packages, for example `libwayland-dev libx11-dev libxfixes-dev` on Debian/Ubuntu. Windows uses the Win32 SDK, and macOS links AppKit and ApplicationServices.

## Linux backends

The package treats X11 and native Wayland as different backend families. To use the full X11 backend, select X11 before `app.ready` and configure with `backend: "x11"`:

```js
app.commandLine.appendSwitch('ozone-platform', 'x11');
```

This also works through XWayland and provides external window discovery, transient parenting, global positioning, and fullscreen stacking policy.

When Electron runs as a native Wayland client, pass the `BrowserWindow` itself to `configure()`. The `wayland-electron` backend uses Electron for click-through and best-effort always-on-top behavior. It cannot discover or parent arbitrary external windows, use global positioning, or guarantee placement above fullscreen content. These limitations are exposed through `overlay.getCapabilities()`.

The experimental `wayland-layer-shell` backend owns a separate overlay-layer surface, uses an empty input region and keyboard interactivity `none`, and fills a selected `wl_output`. Electron renders HTML/CSS into an offscreen `BrowserWindow`. Shared-texture DMA-BUFs are imported directly when the compositor advertises the exact format and modifier, with Electron's texture lease retained through compositor release. Otherwise, complete premultiplied BGRA frames use paced readback and double-buffered `wl_shm`. A single newest-frame mailbox provides bounded backpressure for both transports.

KWin parent awareness remains separate from surface ownership. The planned integration will dynamically load a session script from `$XDG_RUNTIME_DIR`, use it only for game discovery and output/workspace/visibility policy, and remove it when the overlay closes.

See [`packages/electron-overlay/README.md`](packages/electron-overlay/README.md) for API usage.

## Visual demos

The private [`packages/demo`](packages/demo) workspace contains deterministic, screenshot-ready Electron scenes for fixed bounds, controller policy changes, cross-process parent discovery and lifecycle transitions, input routing, coordinate diagnostics, native Wayland compatibility, and native Wayland layer shell. Each scene emits a machine-readable readiness report after renderer stabilization and native request/state validation so VM automation knows when to begin compositor-frame stabilization and capture.

```sh
npm run demo -- --demo=bounds
npm run demo -- --demo=policy
npm run demo -- --demo=parent
npm run demo -- --demo=parent-fullscreen
npm run demo -- --demo=parent-transition
npm run demo -- --demo=coordinates
```

In Windows PowerShell, invoke the `npm.cmd` shim so arguments after `--` reach Electron:

```powershell
npm.cmd run demo -- --demo=policy
```

See [`packages/demo/README.md`](packages/demo/README.md) for the layer-shell command and screenshot contract.

Run all visual scenarios in a disposable Linux x64 OrbStack machine:

```sh
npm run test:visual:orbstack
```
