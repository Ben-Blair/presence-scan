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

- **Orb** — color, size, brightness, halo, splat-glow intensity/radius, hover height.
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
