# Garage Splat Viewer

Interactive 3D viewer for the garage gaussian splat, built on the PlayCanvas engine.
Walk around the scan, place a glowing location orb (ready for an HLK mmWave sensor
feed), and cut walls away when viewing from outside.

## Run

```bash
npm install
npm run dev
```

Open the printed URL (default http://localhost:5173).

`npm run dev` starts the Vite viewer and the ESPHome→WebSocket bridge. For the
viewer only (no sensor), use `npm run dev:vite-only`.

## mmWave sensor (HLK LD2450 + ESPHome)

The viewer does not talk to ESPHome directly. ESPHome's `web_server` exposes
sensor state as **Server-Sent Events** (`http://<host>/events`); the browser
client expects a plain **WebSocket** stream of JSON `{"x": <mm>, "y": <mm>}`.
`scripts/esphome-bridge.mjs` translates between the two.

### Setup

1. Copy `.env.example` to `.env` and set `ESPHOME_HOST` to your node's hostname
   or IP (default in the bridge: `garage-radar.local`).
2. In ESPHome, expose the LD2450 target position as two **template or sensor
   entities named exactly** `Orb X` and `Orb Y` (millimetres, sensor at origin).
   ESPHome slugifies these to `sensor-orb_x` and `sensor-orb_y` in the SSE feed —
   those ids are hardcoded in the bridge; rename the sensors in YAML if you change
   the names.
3. Enable `web_server` on the ESPHome device.
4. Run `npm run dev`, open the viewer, set **Orb Position Source** to **mmWave
   sensor**, click **Connect** (WebSocket URL defaults to `ws://localhost:8081`).
5. Calibrate **originX**, **originZ**, **rotationDeg**, **scale**, and **mirror Y**
   in the panel until the orb lines up with your position in the splat.

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
  (JSON messages `{"x": <mm>, "y": <mm>}` with origin/rotation/scale calibration).

## Assets

- `public/assets/garage.sog` — compressed from `garage30000.ply` (944 MB -> 54 MB) via
  `npx @playcanvas/splat-transform garage30000.ply -H 1 garage.sog`
- `public/assets/garagecollisionmesh.glb` — collision/occlusion mesh
