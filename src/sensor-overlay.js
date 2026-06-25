import { Vec3, Color } from 'playcanvas';

// Immediate-mode debug overlay for the mmWave sensor. It draws, every frame and
// in world space, where the program *thinks* the sensor sits and looks — so you
// can drag the originX / originZ / rotationDeg (and mirror) controls and watch
// the gizmo line up with where the sensor really is in the scan, then confirm
// the tracked object (orb) lands correctly.
//
// The cone footprint is mapped through the exact same sensorToWorld() transform
// the live data uses, so what you see is what the mapping does.

const HALF_FOV_DEG = 60;    // LD2450 ~120° horizontal field of view
const MAX_RANGE_MM = 6000;  // ~6 m usable range
const ARC_STEPS = 12;
const SAMPLE_STALE_MS = 1500;

const COL_CONE = new Color(0.25, 0.8, 1.0);    // FOV footprint
const COL_FWD = new Color(1.0, 0.85, 0.2);     // straight-ahead axis
const COL_MARK = new Color(0.35, 0.95, 1.0);   // sensor body marker
const COL_DETECT = new Color(1.0, 0.45, 0.15); // sensor → tracked object

export class SensorOverlay {
    constructor(app, params, orb, sources) {
        this.app = app;
        this.params = params;
        this.orb = orb;
        this.sources = sources;
        this._apex = new Vec3();
        this._mount = new Vec3();
        this._fwd = new Vec3();
        // pre-allocated arc footprint points (no per-frame allocation)
        this._arc = Array.from({ length: ARC_STEPS + 1 }, () => new Vec3());
    }

    /** Map sensor space (mm) to world via the live transform, copied into `out`. */
    _toWorld(sx, sy, out) {
        return out.copy(this.sources.sensorToWorld(sx, sy));
    }

    update() {
        const s = this.params.source.sensor;
        if (!s.showOverlay || this.params.source.mode !== 'sensor') return;
        const app = this.app;

        // apex = the sensor origin projected onto the orb travel plane
        this._toWorld(0, 0, this._apex);
        // marker = the sensor body at its mounting height above the floor
        this._mount.set(s.originX, this.params.source.floorY + s.mountHeight, s.originZ);

        // FOV footprint on the orb plane, sampled through the real transform
        const arc = this._arc;
        for (let i = 0; i <= ARC_STEPS; i++) {
            const deg = -HALF_FOV_DEG + (2 * HALF_FOV_DEG * i) / ARC_STEPS;
            const rad = (deg * Math.PI) / 180;
            this._toWorld(MAX_RANGE_MM * Math.sin(rad), MAX_RANGE_MM * Math.cos(rad), arc[i]);
        }
        app.drawLine(this._apex, arc[0], COL_CONE, false);
        app.drawLine(this._apex, arc[ARC_STEPS], COL_CONE, false);
        for (let i = 0; i < ARC_STEPS; i++) app.drawLine(arc[i], arc[i + 1], COL_CONE, false);

        // straight-ahead axis so you can see which way it faces
        this._toWorld(0, MAX_RANGE_MM * 0.5, this._fwd);
        app.drawLine(this._apex, this._fwd, COL_FWD, false);

        // sensor body marker + pole down to the floor plane
        app.drawWireSphere(this._mount, 0.12, COL_MARK, 12, false);
        app.drawLine(this._mount, this._apex, COL_MARK, false);

        // live detection: line from the sensor to the tracked object
        const last = this.sources.lastSample;
        if (last && !(last.x === 0 && last.y === 0) && performance.now() - last.t < SAMPLE_STALE_MS) {
            app.drawLine(this._mount, this.orb.getPosition(), COL_DETECT, false);
        }
    }
}
