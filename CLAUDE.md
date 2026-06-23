# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based 3D viewer for a gaussian-splat scan of a garage, built directly on the
PlayCanvas engine (no editor, no framework). It renders the splat, places a glowing
"location orb" on the floor, and can drive that orb from a live HLK/LD2450 mmWave radar
sensor so a person walking the real garage shows up as the orb in the scan.

## Commands

```bash
npm install
npm run dev          # vite (port 5173) + the ESPHome bridge concurrently
npm run dev:vite-only # viewer only, no sensor bridge
npm run build        # vite production build -> dist/
npm run preview      # serve the built dist/
npm run bridge       # run only scripts/esphome-bridge.mjs
```

There is no test suite and no eslint config checked in (despite an `npx eslint`
permission). "Verifying" a change means running `npm run dev` and exercising it in the
browser; `window.__viewer` exposes `{ app, splat, camera, controls, orb, sources,
autoCam, minimap, center, halfExtents, params }` for console inspection.

The sensor host is configured via `.env` (`RADAR_PROXY_TARGET`) and the bridge reads
`ESPHOME_HOST` / `PORT` from the environment.

## Architecture

Everything is wired together in `src/main.js`. The flow: load the two assets, derive
room bounds, build the scene graph, then drive everything from a single `app.on('update')`
loop. `buildScene()` is a high-level orchestrator that delegates to module-level helpers —
`deriveRoomBounds(collisionMesh)` (measures the collision mesh, returns its AABB or null),
`generateDefaultAnchors(center, halfExtents)` (returns the four quadrant anchors), and
`wireHotkeys(...)` (binds the keyboard shortcuts). The major subsystems are independent
classes constructed once in `buildScene()`:

- **`Orb`** (`orb.js`) — emissive sphere that writes depth. Holds a `target` and eases its
  actual position toward it each frame (exponential smoothing). `teleport()` snaps, `setTarget()` eases.
- **`OrbSources`** (`orb-sources.js`) — decides where the orb's target should be. Three modes
  selected by `params.source.mode`: `click` (double-click floor + arrow keys), `demo`
  (lissajous wander), `sensor` (WebSocket JSON `{x, y}` in mm). `sensorToWorld()` applies
  the origin/rotation/scale/flip calibration that maps sensor space to world space.
- **`SplatFX`** (`splat-effects.js`) — the visual heart. Installs a custom `gsplatModifyVS`
  shader chunk (both GLSL and WGSL — keep them in sync) on the shared gsplat material. It
  does the orb glow (point-light falloff, surface-normal-aware via the gaussian's flattest
  axis) and the cutaway/dollhouse fade. Uniforms are pushed via `setParams()`.
- **`WaypointCamera`** (`waypoint-camera.js`) — the "anchor follow" / cinematic camera
  (toggled by `params.camera.orbitOrb`, key `O`). Floor is partitioned into zones, each with
  a high corner "anchor eye." The orb is projected onto a control loop (zone centers) to get a
  rail parameter, and the camera rides the co-indexed rail loop (anchor eyes). It drives the
  camera entity directly and suspends the manual `CameraControls` while active.
- **`CameraControls`** (`camera-controls.js`) — manual desktop fly/orbit/pan camera, keyboard +
  mouse only. Adapted from the PlayCanvas multi-platform camera example, then stripped to the
  desktop kiosk: no mobile/touch/gamepad/XR input paths. `main.js` only sets `moveSpeed`,
  `moveFastSpeed`, `rotateSpeed`, `zoomRange`; the controllers keep their own damping/range
  defaults.
- **`SensorMinimap`** (`sensor-minimap.js`) — bottom-left radar plot of the live mmWave stream,
  visible only in sensor mode.
- **Settings panel** (`settings.js` + `panel-controls.js` + `panel.css`) — a hand-rolled,
  dependency-free control toolkit (replaced Tweakpane). Controls write straight through to the
  shared `params` object and fire `onChange` hooks defined in `main.js`.

### Critical conventions

- **Two coordinate flips matter.** The splat is rendered with `setLocalEulerAngles(180, 0, 0)`
  because raw 3DGS data is y-down. Room bounds come from the **collision mesh** (`garagecollisionmesh.glb`),
  *not* the splat AABB — the splat AABB is bloated by floater outliers. The collision mesh is
  measured then immediately `destroy()`ed; it is never rendered.

- **The splat shader runs in world space.** In PlayCanvas unified gsplat mode, the
  `gsplatModifyVS` chunk runs in the copy-to-workbuffer pass where splat centers are already in
  world space — so orb/camera positions are passed as plain world coordinates.

- **Setting a gsplat parameter is expensive.** It marks the placement render-dirty (re-copies the
  workbuffer and resorts). `SplatFX.setParams()` takes a named-field object (`orbPos`, `orbColor`,
  `cutCamPos`, `viewPos`, etc.) and short-circuits when nothing changed — it flattens those fields
  into a change-key and compares against the last. `main.js` quantizes positions (`round(v, 0.01)`
  etc.) before passing them so tiny jitter doesn't trigger a resort every frame. Preserve both the
  named contract and the quantization when touching the update loop.

- **Params and persistence.** `defaults.json` holds shipped defaults (a `view` and a `params`
  tree). `params.js` exports the single live `params` object (a clone of the defaults).
  `settings-store.js` deep-merges a localStorage session over the defaults on startup and writes
  it back on save (key `garage-viewer-settings`). The whole app reads and mutates that one shared
  `params` object — there is no reactive layer, so changes take effect because the update loop
  reads the fields every frame, and panel `onChange` hooks call back into `main.js` to apply
  things that aren't read live (e.g. camera FOV, render scale).

- **Anchors auto-generate.** If `params.camera.anchors` is empty at load, `generateDefaultAnchors()`
  derives four quadrant zones with diagonally-opposite high corner eyes from the runtime room bounds.
  Captured anchors (keys `1`–`4`, persisted via the session store) override these.

### The sensor path

ESPHome's `web_server` only emits Server-Sent Events; the viewer only speaks raw WebSocket.
`scripts/esphome-bridge.mjs` bridges them: it connects to `http://<host>/events` (using `node:http`
deliberately — undici/`fetch` stalls on ESPHome's chunked encoding), parses the `Orb X` / `Orb Y`
sensor states, and rebroadcasts `{x, y}` JSON on `ws://localhost:8081`. The viewer's sensor mode
connects to that WebSocket.
