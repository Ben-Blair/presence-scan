// Demo-mode brain: drives the demo orb(s) on A* paths across the nav grid.
// Each orb repeatedly samples a random reachable goal, plans with A*, string-
// pulls the path, rounds its corners with collision-checked Bezier arcs
// (`roundCorners`), and follows the result at a constant speed — so motion
// flows in smooth curves rather than polyline kinks. New goals are biased to
// lie roughly ahead of the current travel direction, so the wander keeps
// moving forward instead of bouncing back and forth between random targets.
// The next goal is chained on shortly before the orb reaches its current one
// (falling back to any reachable goal, ahead or not, right at the end) so it
// never stops mid-wander — a sharp turn beats a pause.
// With more than one orb, avoidance is mutual: every orb plans around the
// other orbs' current positions (cells near them become a temporary blocked
// overlay) and replans when another orb wanders onto its remaining path; an
// orb that gets boxed in idles briefly and then resamples, so head-to-head
// meetings resolve instead of deadlocking. Deterministic given an injected
// rng — the pure helpers (`advanceAlongPath`, `roundCorners`, `wrapAngle`,
// `sampleGoal`) are unit-tested directly.

import { Vec3 } from 'playcanvas';
import { findPath, smoothPath } from './astar.js';
import { worldToCell, cellToWorld, cellIndex, isBlocked, computeReachable, nearestFreeCell } from './nav-grid.js';
import { insetBoundsXZ } from './math-utils.js';

/** @typedef {import('./nav-grid.js').NavGrid} NavGrid */

const REPLAN_CHECK_INTERVAL = 0.25; // s between path-conflict checks
const RETRY_DELAY = 1;              // s to idle after a failed plan
const MIN_GOAL_DIST = 1.5;          // m — don't pick goals right next to the orb
const GOAL_TRIES = 20;
const CORNER_RADIUS = 0.35;         // m — how far before/after a corner the arc starts
const AHEAD_DOT = 0.2;              // goal direction · heading for "roughly ahead"
const CHAIN_DIST = 0.9;             // m — remaining path length that triggers chaining
const CHAIN_FALLBACK_DIST = 0.3;    // m — inside this, chaining accepts any goal, not just ahead ones

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
}

/**
 * Move `pos` by `dist` along the waypoint polyline, consuming waypoints as
 * they're reached. Mutates `pos` (x/z only) and returns the new waypoint
 * index (`points.length` once the whole path is consumed).
 *
 * @param {{x:number, z:number}[]} points
 * @param {number} idx - current waypoint index
 * @param {{x:number, z:number}} pos - current position (mutated)
 * @param {number} dist - distance to travel (m)
 * @returns {number}
 */
export function advanceAlongPath(points, idx, pos, dist) {
    while (dist > 0 && idx < points.length) {
        const wp = points[idx];
        const dx = wp.x - pos.x;
        const dz = wp.z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d <= dist) {
            pos.x = wp.x;
            pos.z = wp.z;
            idx++;
            dist -= d;
        } else {
            pos.x += (dx / d) * dist;
            pos.z += (dz / d) * dist;
            dist = 0;
        }
    }
    return idx;
}

/** Every cell under the segment (sampled at quarter-cell steps) is free. */
function segmentClear(grid, x0, z0, x1, z1, overlay) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (grid.cell * 0.25)));
    for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const c = worldToCell(grid, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
        if (isBlocked(grid, c.cx, c.cz, overlay)) return false;
    }
    return true;
}

/**
 * Replace each interior corner of a polyline with a quadratic Bezier arc:
 * back off up to `radius` along both adjoining segments (clamped to half the
 * segment so neighboring corners can't overlap) and sample the curve between
 * the two offset points, subdividing finer for sharper corners. Each rounded
 * corner is collision-checked against the grid (half-cell sampling) and falls
 * back to the original sharp corner if the arc would clip a blocked cell.
 * Endpoints are preserved.
 *
 * @param {NavGrid} grid
 * @param {{x:number, z:number}[]} points - world-space waypoints
 * @param {number} radius - corner rounding radius (m)
 * @param {Set<number>} [overlay] - extra blocked cells (dynamic obstacles)
 * @returns {{x:number, z:number}[]}
 */
export function roundCorners(grid, points, radius, overlay) {
    if (points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const A = points[i - 1];
        const B = points[i];
        const C = points[i + 1];
        const inLen = Math.hypot(B.x - A.x, B.z - A.z);
        const outLen = Math.hypot(C.x - B.x, C.z - B.z);
        const r1 = Math.min(radius, inLen / 2);
        const r2 = Math.min(radius, outLen / 2);
        if (inLen < 1e-6 || outLen < 1e-6) {
            out.push(B);
            continue;
        }
        const p0 = { x: B.x + ((A.x - B.x) / inLen) * r1, z: B.z + ((A.z - B.z) / inLen) * r1 };
        const p1 = { x: B.x + ((C.x - B.x) / outLen) * r2, z: B.z + ((C.z - B.z) / outLen) * r2 };
        // subdivide finer for sharper corners (~one point per 20° of turn)
        const turn = Math.abs(wrapAngle(
            Math.atan2(C.z - B.z, C.x - B.x) - Math.atan2(B.z - A.z, B.x - A.x)));
        const n = Math.min(8, Math.max(2, Math.ceil(turn / 0.35)));
        const arc = [p0];
        for (let k = 1; k < n; k++) {
            const t = k / n;
            const u = 1 - t;
            arc.push({
                x: u * u * p0.x + 2 * u * t * B.x + t * t * p1.x,
                z: u * u * p0.z + 2 * u * t * B.z + t * t * p1.z
            });
        }
        arc.push(p1);
        let clear = true;
        for (let k = 0; k < arc.length - 1 && clear; k++) {
            clear = segmentClear(grid, arc[k].x, arc[k].z, arc[k + 1].x, arc[k + 1].z, overlay);
        }
        if (clear) {
            out.push(...arc);
        } else {
            out.push(B); // tight spot — keep the exact A* corner
        }
    }
    out.push(points[points.length - 1]);
    return out;
}

/**
 * Sample a goal cell uniformly from the reachable-cell list, subject to the
 * wander constraints. Constraints relax pass by pass so small free regions
 * still yield goals: first `GOAL_TRIES` tries want a goal roughly *ahead* of
 * `opts.heading` (forward-flowing wander, no doubling back) and at least
 * `minDist` away; then the ahead requirement drops; then `minDist` too.
 * Returns null when nothing fits.
 *
 * @param {NavGrid} grid
 * @param {number[]} list - reachable cell indices (from computeReachable)
 * @param {() => number} rng
 * @param {{ from: {x:number, z:number}, minDist: number,
 *           avoid: {x:number, z:number}[], avoidRadius: number,
 *           box: {minX:number, maxX:number, minZ:number, maxZ:number} | null,
 *           heading?: number, requireAhead?: boolean, overlay?: Set<number> }} opts
 * @returns {{cx:number, cz:number} | null}
 */
export function sampleGoal(grid, list, rng, opts) {
    if (!list.length) return null;
    const hasHeading = typeof opts.heading === 'number';
    const h = opts.heading ?? 0;
    const hx = hasHeading ? Math.cos(h) : 0;
    const hz = hasHeading ? Math.sin(h) : 0;
    // requireAhead: no relaxed passes — used for chaining, where a behind
    // goal would put an un-roundable hairpin in the middle of the path
    const passes = opts.requireAhead && hasHeading ? 1 : 3;
    for (let pass = 0; pass < passes; pass++) {
        const wantAhead = pass === 0 && hasHeading;
        const minDist = pass < 2 ? opts.minDist : 0;
        for (let t = 0; t < GOAL_TRIES; t++) {
            const idx = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
            const cx = idx % grid.cols;
            const cz = (idx - cx) / grid.cols;
            if (opts.overlay?.has(idx)) continue;
            const { x, z } = cellToWorld(grid, cx, cz);
            if (opts.box && (x < opts.box.minX || x > opts.box.maxX ||
                             z < opts.box.minZ || z > opts.box.maxZ)) continue;
            const dx = x - opts.from.x;
            const dz = z - opts.from.z;
            const dist = Math.hypot(dx, dz);
            if (dist < minDist) continue;
            if (wantAhead && dist > 0 && (dx * hx + dz * hz) / dist < AHEAD_DOT) continue;
            if (opts.avoid.some((a) => Math.hypot(x - a.x, z - a.z) < opts.avoidRadius)) continue;
            return { cx, cz };
        }
    }
    return null;
}

/** Squared distance from point p to segment ab (all XZ). */
function pointSegDistSq(px, pz, ax, az, bx, bz) {
    const abx = bx - ax;
    const abz = bz - az;
    const lenSq = abx * abx + abz * abz;
    const t = lenSq > 0 ? Math.min(1, Math.max(0, ((px - ax) * abx + (pz - az) * abz) / lenSq)) : 0;
    const dx = px - (ax + abx * t);
    const dz = pz - (az + abz * t);
    return dx * dx + dz * dz;
}

/**
 * @typedef {Object} WanderState
 * @property {Vec3} pos - the orb's target point riding along the path
 * @property {number} heading - last travel direction (radians, atan2(z, x))
 * @property {Vec3[]} path - remaining world-space waypoints
 * @property {number} waypointIdx
 * @property {{cx:number, cz:number} | null} goal
 * @property {number} idle - seconds left to wait before planning again
 * @property {number} replanTimer - countdown to the next conflict check
 */

export class DemoWander {
    /**
     * @param {NavGrid} grid
     * @param {*} params - the shared live params object
     * @param {{center: Vec3, halfExtents: Vec3}} roomBounds
     * @param {() => number} [rng]
     */
    constructor(grid, params, roomBounds, rng = Math.random) {
        this.grid = grid;
        this.params = params;
        this.roomBounds = roomBounds;
        this.rng = rng;
        /** @type {WanderState[]} */
        this.states = [];
        /** @type {number[]} */
        this.reachable = [];
    }

    get _travelY() {
        return this.params.source.floorY + this.params.orb.height;
    }

    /**
     * The wander box: the full room (inset by a small fixed margin) normally,
     * so the orb explores everywhere it's visible. Only when the cutaway
     * effect is actually peeling the walls back (`cutOn`) is it further inset
     * by the wall-peel depths, matching the old lissajous demo's constraint so
     * the orb stays in the still-rendered part of the dollhouse view. Null
     * when the (peeled) box leaves no room.
     *
     * @param {boolean} [cutOn] - whether cutaway is currently engaged
     */
    _goalBox(cutOn) {
        const b = insetBoundsXZ(this.roomBounds.center, this.roomBounds.halfExtents, 0.15);
        if (!cutOn) return (b.minX < b.maxX && b.minZ < b.maxZ) ? b : null;
        const wp = this.params.cutaway.wallPeels;
        const box = {
            minX: b.minX + (wp.xNeg ?? 0),
            maxX: b.maxX - (wp.xPos ?? 0),
            minZ: b.minZ + (wp.zNeg ?? 0),
            maxZ: b.maxZ - (wp.zPos ?? 0)
        };
        return (box.minX < box.maxX && box.minZ < box.maxZ) ? box : null;
    }

    /**
     * Swap in a rebuilt grid (cell size / clearance changed); replan from
     * where the orbs stand.
     *
     * @param {NavGrid} grid
     * @param {boolean} [cutOn] - whether cutaway is currently engaged
     */
    setGrid(grid, cutOn = false) {
        this.grid = grid;
        if (this.states.length) this.reset(this.states[0].pos, cutOn);
    }

    /**
     * (Re)spawn the orbs for demo-mode entry. Orb 0 starts from `primaryPos`
     * (snapped to the nearest free cell if it stands inside an obstacle);
     * later orbs spawn on random reachable cells clear of the ones before.
     *
     * @param {{x:number, y:number, z:number}} primaryPos
     * @param {boolean} [cutOn] - whether cutaway is currently engaged
     */
    reset(primaryPos, cutOn = false) {
        const demo = this.params.source.demo;
        const n = Math.min(3, Math.max(1, Math.round(demo.orbCount)));
        const y = this._travelY;

        const start = new Vec3(primaryPos.x, y, primaryPos.z);
        let cell = worldToCell(this.grid, start.x, start.z);
        if (isBlocked(this.grid, cell.cx, cell.cz)) {
            cell = nearestFreeCell(this.grid, cell.cx, cell.cz) ?? cell;
            const w = cellToWorld(this.grid, cell.cx, cell.cz);
            start.set(w.x, y, w.z);
        }
        this.reachable = computeReachable(this.grid, cell.cx, cell.cz).list;

        this.states = [this._makeState(start)];
        for (let i = 1; i < n; i++) {
            const spawn = sampleGoal(this.grid, this.reachable, this.rng, {
                from: this.states[0].pos,
                minDist: Math.max(demo.avoidRadius, 1),
                avoid: this.states.map((s) => s.pos),
                avoidRadius: demo.avoidRadius,
                box: this._goalBox(cutOn)
            });
            const w = spawn
                ? cellToWorld(this.grid, spawn.cx, spawn.cz)
                : { x: start.x + 0.5 * i, z: start.z }; // degenerate grid — stack beside orb 0
            this.states.push(this._makeState(new Vec3(w.x, y, w.z)));
        }
    }

    /** @param {Vec3} pos */
    _makeState(pos) {
        return {
            pos,
            heading: wrapAngle(this.rng() * 2 * Math.PI),
            path: [],
            waypointIdx: 0,
            goal: null,
            idle: 0,
            replanTimer: 0
        };
    }

    /**
     * Advance every orb one frame. Returns the world-space target list for
     * `OrbField.setTargets()` (the returned Vec3s are copied by the field).
     *
     * @param {number} dt
     * @param {boolean} [cutOn] - whether cutaway is currently engaged
     * @returns {Vec3[]}
     */
    update(dt, cutOn = false) {
        const speed = this.params.source.demoSpeed;
        const y = this._travelY;

        for (let i = 0; i < this.states.length; i++) {
            const s = this.states[i];
            s.pos.y = y;

            if (s.idle > 0) {
                s.idle -= dt;
                continue;
            }

            const overlay = this.states.length > 1 ? this._avoidOverlay(i) : undefined;

            // another orb wandered onto our remaining path → replan around it
            if (overlay && s.waypointIdx < s.path.length) {
                s.replanTimer -= dt;
                if (s.replanTimer <= 0) {
                    s.replanTimer = REPLAN_CHECK_INTERVAL;
                    if (this._pathConflicts(s, i) && !this._plan(s, s.goal, overlay)) {
                        s.path = [];
                        s.idle = RETRY_DELAY * 0.5; // boxed in — wait for the other orb to move on
                        continue;
                    }
                }
            }

            if (s.waypointIdx >= s.path.length) {
                // no path yet — only happens on bootstrap, or when a boxed-in
                // orb's idle just expired: chaining below keeps this from
                // being hit in the middle of ordinary wandering. Pick a fresh
                // goal and plan; whatever direction it sets off in, keep
                // moving the same frame rather than pausing to turn.
                const goal = this._sampleGoalFor(s, s.pos, s.heading, overlay, false, cutOn);
                if (!goal || !this._plan(s, goal, overlay)) {
                    s.idle = RETRY_DELAY;
                    continue;
                }
            } else if (s.goal && s.path.length >= 2 && this._remaining(s) < CHAIN_DIST) {
                // nearly there: chain the next goal on *before* arriving, so
                // the orb is never left without a path to follow. An ahead
                // goal keeps the junction an interior corner that roundCorners
                // turns into an arc; once we're within CHAIN_FALLBACK_DIST and
                // still haven't found one (cornered), any reachable goal will
                // do — a sharp turn beats stopping.
                const end = s.path[s.path.length - 1];
                const prev = s.path[s.path.length - 2];
                const endDir = Math.atan2(end.z - prev.z, end.x - prev.x);
                const requireAhead = this._remaining(s) > CHAIN_FALLBACK_DIST;
                const next = this._sampleGoalFor(s, end, endDir, overlay, requireAhead, cutOn);
                if (next) this._plan(s, s.goal, overlay, next);
            }

            const px = s.pos.x;
            const pz = s.pos.z;
            s.waypointIdx = advanceAlongPath(s.path, s.waypointIdx, s.pos, speed * dt);
            // track the travel direction for forward-biased goal sampling
            const dx = s.pos.x - px;
            const dz = s.pos.z - pz;
            if (dx * dx + dz * dz > 1e-12) s.heading = Math.atan2(dz, dx);
        }
        return this.states.map((s) => s.pos);
    }

    /** Sample the next wander goal for orb `s`, seen from `from` facing `heading`. */
    _sampleGoalFor(s, from, heading, overlay, requireAhead, cutOn) {
        return sampleGoal(this.grid, this.reachable, this.rng, {
            from,
            minDist: MIN_GOAL_DIST,
            heading,
            requireAhead,
            avoid: this.states.filter((o) => o !== s).map((o) => (o.goal
                ? cellToWorld(this.grid, o.goal.cx, o.goal.cz)
                : { x: o.pos.x, z: o.pos.z })),
            avoidRadius: this.params.source.demo.avoidRadius,
            box: this._goalBox(cutOn),
            overlay
        });
    }

    /** Remaining travel distance from the orb's position to the end of its path. */
    _remaining(s) {
        let d = 0;
        let ax = s.pos.x;
        let az = s.pos.z;
        for (let k = s.waypointIdx; k < s.path.length; k++) {
            d += Math.hypot(s.path[k].x - ax, s.path[k].z - az);
            ax = s.path[k].x;
            az = s.path[k].z;
        }
        return d;
    }

    /**
     * A* from the orb's current cell to `goal` (and on to `chainGoal` when
     * given): string-pulled, corner-rounded and converted to world waypoints
     * on the travel plane. Returns false when `goal` is unreachable; a failed
     * chain leg just isn't appended.
     *
     * @param {WanderState} s
     * @param {{cx:number, cz:number} | null} goal
     * @param {Set<number>} [overlay]
     * @param {{cx:number, cz:number} | null} [chainGoal]
     * @returns {boolean}
     */
    _plan(s, goal, overlay, chainGoal = null) {
        if (!goal) return false;
        const from = worldToCell(this.grid, s.pos.x, s.pos.z);
        const cells = findPath(this.grid, from, goal, overlay);
        if (!cells) return false;
        let pts = smoothPath(this.grid, cells, overlay)
            .map((c) => cellToWorld(this.grid, c.cx, c.cz));
        let finalGoal = goal;
        if (chainGoal && pts.length >= 2) {
            const cells2 = findPath(this.grid, goal, chainGoal, overlay);
            const pts2 = cells2 && smoothPath(this.grid, cells2, overlay)
                .map((c) => cellToWorld(this.grid, c.cx, c.cz));
            // the sampled chain goal lies ahead, but its A* route may still
            // set off backwards (e.g. around the car) — only append when the
            // actual junction turn is arc-roundable, else arrive and pause
            if (pts2 && pts2.length >= 2) {
                const a = pts[pts.length - 2];
                const b = pts[pts.length - 1];
                const turn = Math.abs(wrapAngle(
                    Math.atan2(pts2[1].z - b.z, pts2[1].x - b.x) -
                    Math.atan2(b.z - a.z, b.x - a.x)));
                if (turn < Math.PI / 2) {
                    pts = pts.concat(pts2.slice(1));
                    finalGoal = chainGoal;
                }
            }
        }
        // start the path at the actual position, not the cell center — the
        // center can sit slightly *behind* the orb, and that first micro-hop
        // backwards is a visible direction flip. If the direct line to the
        // next waypoint clips a blocked cell (the A* corridor is only verified
        // center-to-center), route via the own cell center after all.
        pts[0] = { x: s.pos.x, z: s.pos.z };
        if (pts.length > 1 && !segmentClear(this.grid, pts[0].x, pts[0].z, pts[1].x, pts[1].z, overlay)) {
            pts.splice(1, 0, cellToWorld(this.grid, from.cx, from.cz));
        }
        const y = this._travelY;
        s.path = roundCorners(this.grid, pts, CORNER_RADIUS, overlay)
            .map((p) => new Vec3(p.x, y, p.z));
        s.waypointIdx = 0;
        s.goal = finalGoal;
        s.replanTimer = REPLAN_CHECK_INTERVAL;
        return true;
    }

    /** Cells within avoidRadius of every other orb, as a blocked overlay for orb i. */
    _avoidOverlay(i) {
        const overlay = new Set();
        const r = this.params.source.demo.avoidRadius;
        const rCells = Math.ceil(r / this.grid.cell);
        for (let j = 0; j < this.states.length; j++) {
            if (j === i) continue;
            const p = this.states[j].pos;
            const c = worldToCell(this.grid, p.x, p.z);
            for (let dz = -rCells; dz <= rCells; dz++) {
                for (let dx = -rCells; dx <= rCells; dx++) {
                    const cx = c.cx + dx;
                    const cz = c.cz + dz;
                    if (cx < 0 || cz < 0 || cx >= this.grid.cols || cz >= this.grid.rows) continue;
                    const w = cellToWorld(this.grid, cx, cz);
                    if (Math.hypot(w.x - p.x, w.z - p.z) <= r) overlay.add(cellIndex(this.grid, cx, cz));
                }
            }
        }
        return overlay;
    }

    /** Whether any other orb sits within avoidRadius of orb i's remaining path. */
    _pathConflicts(s, i) {
        const r = this.params.source.demo.avoidRadius;
        const rSq = r * r;
        for (let j = 0; j < this.states.length; j++) {
            if (j === i) continue;
            const p = this.states[j].pos;
            let ax = s.pos.x;
            let az = s.pos.z;
            for (let k = s.waypointIdx; k < s.path.length; k++) {
                const wp = s.path[k];
                if (pointSegDistSq(p.x, p.z, ax, az, wp.x, wp.z) < rSq) return true;
                ax = wp.x;
                az = wp.z;
            }
        }
        return false;
    }
}
