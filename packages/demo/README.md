# electron-overlay visual demos

This private workspace exercises the public API through deterministic Electron scenes intended for compositor-level screenshots in a VM. Each scenario is a separate process so automation can launch, observe, capture, and terminate one behavior at a time.

## Prepare

From the repository root:

```sh
npm install
npm run build
npm run rebuild:electron
```

## Scenarios

| Scenario | API behavior | Expected screenshot evidence |
| --- | --- | --- |
| `bounds` | Backend selection, display conversion, `configure()`, `reapply()`, and state inspection | Cyan transparent overlay aligned inside an opaque reference grid; an OS click at its center changes the underlying probe to `RECEIVED`; native Wayland renders `UNSUPPORTED` |
| `policy` | `setBounds()`, `setClickThrough()`, and `setAlwaysOnTop()` | Amber overlay at its final enlarged bounds; an OS click at its center changes the underlying probe to `RECEIVED`; native Wayland renders `UNSUPPORTED` |
| `parent` | Cross-process `findWindow()`, `attachParent()`, and `useParentBounds()` | Pink overlay edges aligned with a separately launched Electron target process |
| `parent-fullscreen` | Cross-process attachment and fullscreen stacking | A smaller pink HUD remains composed over a fullscreen target process |
| `parent-transition` | Windowed to fullscreen to windowed attachment | Pink edges realign with the restored target; all three native state snapshots are reported |
| `parent-geometry` | Sway IPC movement, target resize, and repeated `useParentBounds()` | Pink edges follow two distinct native parent geometries |
| `parent-lifecycle` | Delayed discovery, parent exit, detach, and replacement | Stale bounds are rejected and the overlay aligns with a replacement process |
| `parent-matching` | Exact, contains, class, missing, invalid, and active duplicate queries | Green diagnostics report both active duplicate candidates selected in turn |
| `input-blocking` | `clickThrough: false` and XTEST input | The overlay probe receives the click while the underlying probe remains armed |
| `coordinates` | Backend, capability, native-display, and overlay-display inspection | Green diagnostics with concrete backend evidence and rectangles |
| `wayland-compat` | Native Wayland capability and unsupported-parent contract | Green diagnostics confirm explicit limitations without asserting global placement |
| `layer-shell` | Native layer-shell creation and Electron offscreen attachment | Purple layer surface filling the selected output with visible compositor aperture |

Launch a regular scenario:

```sh
npm run demo -- --demo=bounds
npm run demo -- --demo=policy
npm run demo -- --demo=parent
npm run demo -- --demo=parent-fullscreen
npm run demo -- --demo=parent-transition
npm run demo -- --demo=parent-geometry
npm run demo -- --demo=parent-lifecycle
npm run demo -- --demo=parent-matching
npm run demo -- --demo=input-blocking
npm run demo -- --demo=coordinates
```

Linux defaults to X11 unless it detects a native Wayland-only session. The backend can be fixed for a VM:

```sh
npm run demo -- --demo=bounds --backend=x11
npm run demo -- --demo=bounds --backend=wayland-electron
```

Launch layer shell in a native Wayland VM or nested compositor:

```sh
LAYER_SHELL_OUTPUT=HEADLESS-1 npm run demo:layer-shell
```

The stable software path is the default. Add `--shared-texture=true` to exercise preferred DMA-BUF import with automatic SHM fallback.

## Screenshot contract

Use a VM output of at least `1280x800` at scale factor 1. The app forces Chromium's device scale factor to 1 and uses no network content, animation, current time, locale-dependent text, or generated values in the visual scene.

Pass a readiness path that already has a writable parent directory:

```sh
npm run demo -- --demo=bounds --ready-file=/tmp/electron-overlay-demo.json
```

The app removes any stale readiness file at startup, then atomically writes the JSON report after renderer stabilization and native request/state validation. Cross-process cases launch `target.mjs`, which has separate readiness, command, and state files so parent transitions are acknowledged independently from the overlay process:

```text
ELECTRON_OVERLAY_DEMO_READY {"schemaVersion":1,"scenario":"bounds",...}
```

Automation should:

1. Start one scenario in a clean VM session.
2. Wait for `ELECTRON_OVERLAY_DEMO_READY` or the readiness file.
3. Require `result` to be `pass`, or `unsupported` where the report identifies a capability-gated backend.
4. For `bounds` and `policy`, issue one OS-level click at the overlay rectangle's center and require the underlying pointer probe to change from `ARMED` to `RECEIVED`; for `input-blocking`, require the overlay probe to receive it instead.
5. Observe desktop frames until two consecutive captures are identical, then capture the entire desktop/output.
6. Compare the screenshot using the scenario's badge, registration marks, reference-grid continuity, pointer state where applicable, and reported backend.
7. Terminate Electron before launching the next scenario.

Readiness means the renderer and native policy requests are complete; regular window backends do not expose compositor presentation acknowledgements. The layer-shell scene additionally waits for the final renderer update to be committed and its buffer to be released by the compositor.

Do not use `BrowserWindow.capturePage()` as the integration screenshot. It can validate Chromium pixels, but it cannot prove compositor transparency, z-order, external parenting, click-through policy, or layer-shell placement.

For nonvisual process checks, `--exit-after-ready=250` exits shortly after emitting readiness.

## OrbStack automation

OrbStack does not provide a graphical VM console by default. The automated runner uses a real headless Sway compositor instead: XWayland hosts the X11 scenarios, native Wayland hosts layer shell, XTEST drives the X11 pointer probes through their native input regions, and `grim` captures the composed virtual output.

From macOS with OrbStack running:

```sh
npm run test:visual:orbstack
```

The command creates a disposable Ubuntu 24.04 amd64 machine, copies the current working tree without host build products, installs Node and native/graphics dependencies, builds against Electron, runs every case in `scenarios.json` at `1280x800`, and deletes the machine. Screenshots, readiness reports, verification metadata, and logs are copied to `artifacts/orbstack-visual/<timestamp>/` even when a scenario fails.

Useful controls:

```sh
ORB_KEEP_VM=true npm run test:visual:orbstack
ORB_TEST_MACHINE=my-visual-test npm run test:visual:orbstack
ORB_TEST_MACHINE=my-visual-test ORB_REUSE_VM=true npm run test:visual:orbstack
ORB_TEST_ARTIFACT_DIR=/tmp/electron-overlay-visual npm run test:visual:orbstack
VISUAL_DEMO_SHARED_TEXTURE=true npm run test:visual:orbstack
```

The default software-rendered layer-shell path is deterministic. `VISUAL_DEMO_SHARED_TEXTURE=true` requests Electron's shared-texture mode and still accepts the documented SHM fallback. OrbStack's headless pixman compositor has no virtual GPU, so this runner does not claim to validate a successful DMA-BUF import; that still requires a GPU-backed Linux compositor.

Sway does not provide traditional maximize behavior and logs X11 `_NET_WM_STATE_STICKY` changes as unhandled. Maximize/minimize and workspace-policy assertions therefore belong in the planned Openbox/picom EWMH suite instead of being reported as passing Sway behavior. Multi-output placement, output removal, KWin, Mutter, and GPU-backed DMA-BUF import also remain separate environment expansions.
