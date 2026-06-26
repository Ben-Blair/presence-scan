# Architecture

A browser-based 3D viewer for a gaussian-splat scan of a garage, built directly on the
[PlayCanvas](https://playcanvas.com/) engine — no editor, no app framework. It renders the
splat, places a glowing "location orb" on the floor, and can drive that orb from a live
HLK/LD2450 mmWave radar so a person walking the real garage shows up as the orb in the scan.

This document is the high-level map. `CLAUDE.md` has the finer-grained conventions.

## Data flow

Everything is wired together in `src/main.js`, which acts as the **composition root**: it loads
the two assets, derives the room bounds, constructs each subsystem once, and then drives all of
them from a single `app.on('update')` loop. There is no reactive layer — the update loop reads
the shared `params` object every frame, so changes take effect immediately.

```
                 defaults.json + localStorage session
                              │
                         (params.js)
                              │  one shared, mutable params object
                              ▼
  ┌──────────────┐   target   ┌──────────┐   positions   ┌────────────┐
  │ OrbSources   │──────────▶ │ OrbField │ ────────────▶ │  SplatFX   │  GPU
  │ click / demo │  (≤3 orbs) │  (Orbs)  │  (≤3 [x,y,z]) │  shader    │ ─────▶ pixels
  │ / sensor WS  │            └──────────┘               │  uniforms  │
  └──────────────┘                 │                     └────────────┘
        ▲                          │ primary()/active()
        │                          ▼
   ESP WebSocket          follow camera · minimap · overlay · session save
```

- **`OrbSources`** (`orb-sources.js`) decides *where* the orbs should be. Three modes selected by
  `params.source.mode`: `click` (double-click the floor + arrow keys), `demo` (lissajous wander),
  and `sensor` (a WebSocket feeding JSON `{targets:[{x,y,speed}, …]}` in millimetres, up to three
  people). `sensorToWorld()` applies the origin/rotation/scale/flip calibration that maps sensor
  space onto the splat.
- **`OrbField`** (`orb-field.js`) owns up to three **`Orb`**s (one per tracked person, index ==
  identity — no swapping). Each `Orb` eases its actual position toward its target each frame
  (exponential smoothing). `primary()` (orb 0) feeds the single-target subsystems; `active()`
  feeds the glow shader, minimap and overlay.
- **`SplatFX`** (`splat-effects.js`) is the visual heart: a custom `gsplatModifyVS` shader chunk
  (GLSL **and** WGSL, kept in sync) installed on the shared gsplat material. It does the orb glow
  and the cutaway/dollhouse wall fade. Uniforms are pushed via `setParams({ orbs, orbColor, … })`.

## Cameras

- **`CameraControls`** (`camera-controls.js`) — the manual desktop fly/orbit/pan camera.
  **Adapted from the official PlayCanvas multi-platform camera example**, then stripped down to a
  desktop kiosk (no touch/gamepad/XR paths). Vendored, derived code — called out here deliberately.
- **`WaypointCamera`** (`waypoint-camera.js`) — the cinematic "anchor follow" camera. The floor is
  partitioned into zones with high-corner "anchor eyes"; the orb is projected onto a control loop
  to get a rail parameter, and the camera rides the co-indexed rail of anchor eyes.

## Settings & persistence

- `defaults.json` holds the shipped defaults (`view` + `params` trees). `params.js` exports the
  single live `params` object (a clone of the defaults). `settings-store.js` deep-merges a
  localStorage session over the defaults on startup and writes it back on save.
- The settings panel (`settings.js` + `panel-controls.js` + `panel.css`) is a hand-rolled,
  dependency-free control toolkit (it replaced Tweakpane). Controls write straight through to
  `params`; `onChange` hooks in `main.js` apply the few things that aren't read live (FOV, etc.).

## Key design decisions (the interesting parts)

- **The splat shader runs in world space.** In PlayCanvas unified gsplat mode, the `gsplatModifyVS`
  chunk executes in the copy-to-workbuffer pass, where splat centers are already world-space — so
  orb/camera positions are passed as plain world coordinates, no extra transforms.
- **Room bounds come from the collision mesh, not the splat.** The raw 3DGS data is bloated by
  floater outliers, so its AABB is wrong. Instead `garagecollisionmesh.glb` is loaded, measured,
  and immediately `destroy()`ed — it is never rendered. (The splat itself is rendered with a
  180° X flip because raw 3DGS data is y-down.)
- **Setting a gsplat uniform is expensive** — it marks the placement render-dirty and forces a
  workbuffer re-copy and resort. So `SplatFX.setParams()` short-circuits when nothing changed, and
  `main.js` **quantizes positions** (`round(v, 0.01)`) before passing them so sub-centimetre jitter
  doesn't trigger a resort every frame. This is the single biggest perf lever in the update loop.
- **The sensor pipeline was rebuilt mid-project.** v1 was an ESPHome device whose `web_server` only
  spoke SSE (which deduped identical states) and exposed one target as two separate sensors, needing
  a Node bridge to re-pair X/Y. v2 is **custom ESP32 firmware** (`firmware/garage-radar/`) that
  parses the raw 30-byte LD2450 UART frame on-device and serves all targets as one JSON packet per
  frame over its own WebSocket at the sensor's native ~10 Hz — no SSE, no bridge, multi-person. The
  viewer must be served over **http** because the ESP serves insecure `ws://` (mixed-content rule).

## Inspecting it live

`npm run dev`, then in the console `window.__viewer` exposes
`{ app, splat, camera, controls, orb, field, sources, autoCam, minimap, sensorOverlay, center,
halfExtents, params }` for poking at the running scene.
