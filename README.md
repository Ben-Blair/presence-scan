# Garage Splat Viewer

Interactive 3D viewer for a gaussian-splat scan of my garage, built on PlayCanvas.
Walk the scan, track people with a live mmWave radar as glowing orbs, and cut walls
away when viewing from outside.

<video src="https://github.com/Ben-Blair/garage-splat-viewer/raw/main/docs/demo.mp4" controls muted playsinline width="100%">
  <a href="docs/demo.mp4">Download demo video</a>
</video>

## Run

```bash
npm install
npm run dev
```

Open the printed URL (default http://localhost:5173).

`npm run dev` starts the Vite viewer. The sensor feed comes straight from the ESP
device — there is no Node bridge to run.

### Checks

```bash
npm run lint        # eslint
npm run typecheck   # tsc --checkJs (JSDoc types, no .ts sources)
npm test            # vitest unit tests
```

Lint, type-check, and tests run in CI on every push/PR and gate the GitHub Pages
deploy (`.github/workflows/`).

## mmWave sensor (HLK LD2450)

The radar runs **custom ESP32 firmware** (`firmware/garage-radar/`) that parses
the raw LD2450 frames and serves all tracked targets over its own **WebSocket**.
The viewer connects directly — no ESPHome, no SSE, no bridge. Each frame is one
packet at the sensor's full ~10 Hz:

```json
{"targets":[{"x":-820,"y":1740,"speed":-12}, {"x":410,"y":2300,"speed":0}]}
```

X/Y are millimetres in sensor space; up to three targets (three people) appear as
three orbs in the scan. See `firmware/garage-radar/README.md` for flashing.

### Setup

1. Flash the firmware (`firmware/garage-radar/` — PlatformIO; fill in WiFi
   `secrets.h`). The device comes up at `ws://garage-radar.local:81`.
2. Run `npm run dev`, open the viewer, set **Orb Position Source** to **mmWave
   sensor**, click **Connect** (WebSocket URL defaults to
   `ws://garage-radar.local:81`).
3. Calibrate **originX**, **originZ**, **rotationDeg**, **scale**, and **mirror Y**
   in the panel until the orb lines up with your position in the splat.

> The viewer must be served over **http** (Vite dev / LAN) — an `https` page
> can't open the insecure `ws://` the ESP serves (mixed content).

### Radar alignment

1. Set orb source to **mmWave sensor** → **Align radar**
2. A **floor radar overlay** appears (120° fan, range rings, like the minimap) plus a **live red dot** on the texture and a **3D red marker** on the floor where the current calibration maps the target.
3. **Space** snaps the sensor mount to your crosshair (wall/ceiling). **Arrows** pan the radar on the floor; **PgUp/PgDn** adjust mount height. Sliders adjust **rotation**, **scale**, and **pan**.
4. Walk around and tune until the red dot tracks your feet in the splat. Press **Set** (or **Enter**) to save. **Esc** cancels.

Fly the camera overhead to read the floor plan: sensor dot at the wedge apex, coverage arc opening into the room, red dot = live target.

## Controls

| Input | Action |
| --- | --- |
| WASD / arrows | Move |
| Left-drag | Rotate / orbit |
| Right-drag | Pan |
| Scroll | Zoom |
| Shift | Move faster |
| Double-click | Place the orb on the floor |
| F | Fly camera to frame the orb |
| H | Save current view as the spawn perspective (persists across reloads) |
| O | Toggle orbit-the-orb mode |

## Settings panel

- **Orb** — color, size, brightness, splat-glow intensity/radius, hover height.
- **Camera** — speeds, orbit-the-orb toggle.
- **Cutaway** — auto/on/off, keep distance, fade softness. In auto mode, walls between
  you and the orb fade out whenever the camera leaves the room.
- **Occlusion** — optional depth-only render of the collision mesh for crisp orb
  occlusion behind walls.
- **Orb Position Source** — click-to-place, demo path, or HLK mmWave over WebSocket
  (JSON `{"targets":[{"x":<mm>,"y":<mm>}, …]}` — up to three people, one orb each —
  with origin/rotation/scale calibration).

## Assets

- `public/assets/garage.sog` — compressed from `garage30000.ply` (944 MB -> 54 MB) via
  `npx @playcanvas/splat-transform garage30000.ply -H 1 garage.sog`
- `public/assets/garagecollisionmesh.glb` — collision/occlusion mesh
