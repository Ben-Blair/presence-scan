import { Vec3 } from 'playcanvas';

const tmpV1 = new Vec3();

/** Ease-in/out curve for the anchor-to-anchor glide. */
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * Fixed Waypoint Anchor + Smooth Look-At camera.
 *
 * The garage floor is partitioned into zones (axis-aligned XZ boxes). Each zone
 * owns one hand-placed, high-up "anchor" camera position — like a virtual
 * security camera mounted in an open interior spot, so it never clips through
 * the splat walls (no raycasting needed). The camera parks on the anchor of the
 * zone the orb is in and only ever *rotates* to keep the orb framed. When the
 * orb settles in a new zone the camera glides to that zone's anchor over a fixed
 * duration.
 *
 * Three independent concerns:
 *   1. Zone selection - discrete + hysteretic (boundary margin + dwell timer).
 *   2. Position       - a timed LERP between two fixed anchor endpoints.
 *   3. Rotation       - continuous exp-smoothing toward the live orb, every frame.
 */
export class WaypointCamera {
    /**
     * @param {*} cameraEntity - camera entity (driven directly while active)
     * @param {*} controls - CameraControls script instance (suspended while active)
     * @param {*} orb - Orb instance
     * @param {*} roomBounds - { center: Vec3, halfExtents: Vec3 } world-space room bounds
     * @param {*} params - global params object
     */
    constructor(cameraEntity, controls, orb, roomBounds, params) {
        this.camera = cameraEntity;
        this.controls = controls;
        this.orb = orb;
        this.roomBounds = roomBounds;
        this.params = params;

        this.active = false;
        this._camPos = new Vec3();
        this._lookTarget = new Vec3();

        // position transition state machine
        this._activeZone = -1;       // zone whose anchor we're parked at / heading to
        this._fromPos = new Vec3();  // tween start (snapshot of camera at commit)
        this._toPos = new Vec3();    // tween end (target anchor eye)
        this._t = 1;                 // tween progress 0..1 (1 = settled)

        // hysteresis
        this._candidate = -1;        // zone the orb has newly entered, pending dwell
        this._dwell = 0;             // seconds the orb has continuously been in candidate
    }

    get _cfg() { return this.params.camera.waypoint; }
    get _anchors() { return this.params.camera.anchors; }

    /**
     * Index of the zone whose XZ box contains the orb. The currently-active zone
     * is inflated by `boundaryMargin` so the orb must clearly leave it before any
     * other zone is considered (first hysteresis layer). Returns -1 if outside
     * every zone.
     */
    _zoneAt(orbPos) {
        const anchors = this._anchors;
        for (let i = 0; i < anchors.length; i++) {
            const b = anchors[i].box;
            const m = (i === this._activeZone) ? this._cfg.boundaryMargin : 0;
            if (orbPos.x >= b.minX - m && orbPos.x <= b.maxX + m &&
                orbPos.z >= b.minZ - m && orbPos.z <= b.maxZ + m) {
                return i;
            }
        }
        return -1;
    }

    /** Nearest zone by XZ distance to its box center (fallback when between zones). */
    _nearestZone(orbPos) {
        const anchors = this._anchors;
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < anchors.length; i++) {
            const b = anchors[i].box;
            const cx = (b.minX + b.maxX) * 0.5;
            const cz = (b.minZ + b.maxZ) * 0.5;
            const dx = orbPos.x - cx;
            const dz = orbPos.z - cz;
            const d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    /** Begin a timed glide from the current camera position to a zone's anchor. */
    _beginTransition(toZone) {
        const e = this._anchors[toZone].eye;
        this._fromPos.copy(this._camPos);
        this._toPos.set(e.x, e.y, e.z);
        this._t = 0;
        this._activeZone = toZone;
    }

    /** Begin waypoint control: capture current pose and suspend manual input. */
    start() {
        if (this.active) return;
        this.active = true;

        this._camPos.copy(this.camera.getPosition());
        this._lookTarget.copy(this.orb.getPosition());
        this._candidate = -1;
        this._dwell = 0;

        if (this._anchors.length > 0) {
            const orbPos = this.orb.getPosition();
            const z = this._zoneAt(orbPos);
            // force a fresh transition (glide) into the orb's zone, even if we
            // happen to start inside it
            this._activeZone = -1;
            this._beginTransition(z >= 0 ? z : this._nearestZone(orbPos));
        }

        this.controls.enabled = false;
    }

    /** End waypoint control: re-sync manual controls to the current pose. */
    stop() {
        if (!this.active) return;
        this.active = false;

        const position = this.camera.getPosition();
        this.controls.reset(this._lookTarget.clone(), position.clone());
        this.controls.enabled = true;
    }

    /**
     * @param {number} dt - The time delta (seconds).
     */
    update(dt) {
        if (!this.active || this._anchors.length === 0) return;
        dt = Math.min(dt, 0.1);

        const cfg = this._cfg;
        const orbPos = this.orb.getPosition();

        // ---- 1. ZONE DETECTION + HYSTERESIS -----------------------------
        const zone = this._zoneAt(orbPos);
        if (zone >= 0 && zone !== this._activeZone) {
            // orb is in a different valid zone - require it to dwell there
            // continuously before committing the switch (second hysteresis layer)
            if (zone === this._candidate) {
                this._dwell += dt;
            } else {
                this._candidate = zone;
                this._dwell = 0;
            }
            if (this._dwell >= cfg.dwellTime) {
                this._beginTransition(zone);
                this._candidate = -1;
                this._dwell = 0;
            }
        } else {
            // back in the active zone, or outside every zone: cancel any pending
            // switch and hold the current anchor
            this._candidate = -1;
            this._dwell = 0;
        }

        // ---- 2. TIMED POSITION TWEEN (anchor A -> anchor B) -------------
        if (this._t < 1) {
            this._t = Math.min(1, this._t + dt / Math.max(cfg.transitionDuration, 0.001));
            this._camPos.lerp(this._fromPos, this._toPos, smoothstep(this._t));
        } else {
            this._camPos.copy(this._toPos); // parked exactly on the anchor
        }

        // ---- 3. ACTIVE TARGET LOCK (every frame) ------------------------
        const lookT = 1 - Math.exp(-cfg.lookSmoothing * dt);
        this._lookTarget.lerp(this._lookTarget, orbPos, lookT);

        this.camera.setPosition(this._camPos);
        this.camera.lookAt(this._lookTarget);
    }
}
