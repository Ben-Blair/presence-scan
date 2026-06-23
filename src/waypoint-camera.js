import { Vec3, math } from 'playcanvas';

const tmpV1 = new Vec3();

/**
 * Anchor camera that rides a continuous rail loop.
 *
 * The floor is partitioned into zones (axis-aligned XZ boxes), each owning one
 * hand-placed, high-up "anchor" camera position. Rather than snapping the camera
 * to one anchor at a time, the anchors are treated as nodes of two co-indexed
 * closed loops, ordered around the room:
 *
 *   - control loop : polyline through the zone CENTERS. The orb is projected
 *                     onto it to get a continuous rail parameter s in [0, N).
 *   - rail loop    : polyline through the anchor EYES. The camera sits at the
 *                     point on this loop at parameter s.
 *
 * So when the orb rests in a zone center the camera parks on that corner anchor;
 * as the orb drifts toward a boundary the camera pre-slides along the track to
 * the neighbouring anchor, and crosses the boundary mid-track with no abrupt
 * reposition. Because the camera is always *on* the rail (never the interior
 * centroid) the oblique across-the-room angle is preserved. The camera only ever
 * rotates to keep the orb framed (active target lock).
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
        this._railS = 0;             // current cyclic rail parameter in [0, N)
    }

    get _cfg() { return this.params.camera.waypoint; }
    get _anchors() { return this.params.camera.anchors; }

    /** XZ center of an anchor's zone box. */
    _zoneCenterX(a) { return (a.box.minX + a.box.maxX) * 0.5; }
    _zoneCenterZ(a) { return (a.box.minZ + a.box.maxZ) * 0.5; }

    /**
     * Anchor indices ordered by the bearing of their zone center around the room
     * center, so consecutive entries are spatially adjacent (the loop goes around
     * the room and doesn't self-cross). Recomputed each frame so captured/edited
     * anchors stay live.
     */
    _loopOrder() {
        const c = this.roomBounds.center;
        const anchors = this._anchors;
        const idx = anchors.map((_, i) => i);
        idx.sort((i, j) => {
            const ai = Math.atan2(this._zoneCenterZ(anchors[i]) - c.z, this._zoneCenterX(anchors[i]) - c.x);
            const aj = Math.atan2(this._zoneCenterZ(anchors[j]) - c.z, this._zoneCenterX(anchors[j]) - c.x);
            return ai - aj;
        });
        return idx;
    }

    /**
     * Project the orb onto the control loop (zone centers in loop order) and
     * return { s, radius }: s = segmentIndex + fraction (cyclic), radius = orb's
     * horizontal distance from the room center (for the center deadzone gate).
     */
    _projectToControlLoop(order, orbPos) {
        const anchors = this._anchors;
        const n = order.length;
        let bestD = Infinity;
        let bestS = 0;
        for (let k = 0; k < n; k++) {
            const a = anchors[order[k]];
            const b = anchors[order[(k + 1) % n]];
            const ax = this._zoneCenterX(a), az = this._zoneCenterZ(a);
            const bx = this._zoneCenterX(b), bz = this._zoneCenterZ(b);
            const ex = bx - ax, ez = bz - az;
            const len2 = ex * ex + ez * ez;
            // closest point on segment [a, b] to the orb, in XZ
            let t = len2 > 1e-9 ? ((orbPos.x - ax) * ex + (orbPos.z - az) * ez) / len2 : 0;
            t = math.clamp(t, 0, 1);
            const px = ax + ex * t, pz = az + ez * t;
            const dx = orbPos.x - px, dz = orbPos.z - pz;
            const d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; bestS = k + t; }
        }
        const c = this.roomBounds.center;
        const rx = orbPos.x - c.x, rz = orbPos.z - c.z;
        return { s: bestS, radius: Math.sqrt(rx * rx + rz * rz) };
    }

    /** Eye position at rail parameter s, with the park curve applied to the fraction. */
    _evalRail(order, s) {
        const anchors = this._anchors;
        const n = order.length;
        const k = Math.floor(s) % n;
        let frac = s - Math.floor(s);
        // park curve: smootherstep pushes the fraction toward 0/1 (toward the
        // anchors) so the camera sticks at corners, sharpened by parkBias.
        const smoother = frac * frac * frac * (frac * (frac * 6 - 15) + 10);
        frac = math.lerp(frac, smoother, math.clamp(this._cfg.parkBias, 0, 1));
        const ea = anchors[order[k]].eye;
        const eb = anchors[order[(k + 1) % n]].eye;
        return tmpV1.set(
            math.lerp(ea.x, eb.x, frac),
            math.lerp(ea.y, eb.y, frac),
            math.lerp(ea.z, eb.z, frac)
        );
    }

    /**
     * Clamp a camera eye to stay inside the room bounds (inset by `margin`), so
     * the follow camera never pokes through a wall — which would both show the
     * exterior and trip the auto-cutaway wall-peel. Mutates and returns `v`.
     */
    _clampToRoom(v, margin) {
        const c = this.roomBounds.center;
        const he = this.roomBounds.halfExtents;
        v.x = math.clamp(v.x, c.x - he.x + margin, c.x + he.x - margin);
        v.z = math.clamp(v.z, c.z - he.z + margin, c.z + he.z - margin);
        v.y = Math.min(v.y, c.y + he.y - margin);
        return v;
    }

    /** Ease `cur` toward `target` along the shorter arc of a length-N ring. */
    _easeCyclic(cur, target, t, n) {
        let diff = (target - cur) % n;
        if (diff > n / 2) diff -= n;
        if (diff < -n / 2) diff += n;
        let next = cur + diff * t;
        next = ((next % n) + n) % n;
        return next;
    }

    /** Begin waypoint control: capture current pose and suspend manual input. */
    start() {
        if (this.active) return;
        this.active = true;

        this._camPos.copy(this.camera.getPosition());
        this._lookTarget.copy(this.orb.getPosition());

        if (this._anchors.length > 0) {
            // seed the rail parameter at the orb's current spot; _camPos eases in
            // from the manual pose to the rail point over the next frames
            const order = this._loopOrder();
            this._railS = this._projectToControlLoop(order, this.orb.getPosition()).s;
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
        const order = this._loopOrder();
        const n = order.length;

        // ---- 1. PROJECT ORB ONTO THE CONTROL LOOP -> rail target ---------
        const { s: sTarget, radius } = this._projectToControlLoop(order, orbPos);

        // ---- 2. RIDE THE RAIL --------------------------------------------
        // ease s along the loop toward the target; gate the rate by the orb's
        // radius from center so noise near the middle (where the projection is
        // ill-conditioned) doesn't spin the rail.
        const r0 = Math.max(this.roomBounds.halfExtents.x, this.roomBounds.halfExtents.z) * 0.25;
        const radiusGate = math.clamp(radius / Math.max(r0, 0.001), 0, 1);
        const sT = (1 - Math.exp(-cfg.railSmoothing * dt)) * radiusGate;
        this._railS = this._easeCyclic(this._railS, sTarget, sT, n);

        // glide the camera toward the rail point, kept inside the walls
        const posT = 1 - Math.exp(-cfg.railSmoothing * dt);
        const railPoint = this._clampToRoom(this._evalRail(order, this._railS), 0.25);
        this._camPos.lerp(this._camPos, railPoint, posT);

        // ---- 3. ACTIVE TARGET LOCK (every frame) -------------------------
        const lookT = 1 - Math.exp(-cfg.lookSmoothing * dt);
        this._lookTarget.lerp(this._lookTarget, orbPos, lookT);

        this.camera.setPosition(this._camPos);
        this.camera.lookAt(this._lookTarget);
    }
}
