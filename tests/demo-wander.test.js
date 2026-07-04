import { describe, it, expect } from 'vitest';
import { Vec3 } from 'playcanvas';
import { DemoWander, advanceAlongPath, roundCorners, wrapAngle, sampleGoal } from '../src/demo-wander.js';
import { findPath } from '../src/astar.js';
import { isBlocked, worldToCell, cellToWorld } from '../src/nav-grid.js';

/** Build a NavGrid from ASCII rows ('#' = blocked, '.' = free); cell = 1 m. */
function gridFrom(rows) {
    const cols = rows[0].length;
    const blocked = new Uint8Array(cols * rows.length);
    rows.forEach((row, cz) => {
        [...row].forEach((ch, cx) => {
            if (ch === '#') blocked[cz * cols + cx] = 1;
        });
    });
    return { cols, rows: rows.length, cell: 1, minX: 0, minZ: 0, blocked };
}

/** Minimal params tree with the fields DemoWander reads. */
function makeParams(overrides = {}) {
    return {
        orb: { height: 0 },
        source: {
            mode: 'demo',
            demoSpeed: 1,
            floorY: 0,
            demo: { orbCount: 2, gridCell: 1, clearance: 0, avoidRadius: 1, showNavDebug: false },
            ...overrides
        },
        cutaway: { wallPeels: { xPos: 0, xNeg: 0, yPos: 0, yNeg: 0, zPos: 0, zNeg: 0 } }
    };
}

/** Room bounds matching a grid at origin (margins outside the 0.15 inset). */
function boundsFor(grid) {
    const hx = grid.cols * grid.cell / 2 + 0.5;
    const hz = grid.rows * grid.cell / 2 + 0.5;
    return {
        center: new Vec3(grid.cols * grid.cell / 2, 0, grid.rows * grid.cell / 2),
        halfExtents: new Vec3(hx, 2, hz)
    };
}

/** Deterministic rng (Lehmer LCG). */
function makeRng(seed = 12345) {
    let s = seed;
    return () => {
        s = (s * 48271) % 2147483647;
        return s / 2147483647;
    };
}

const EMPTY_10x10 = [
    '..........', '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........', '..........'
];

describe('wrapAngle', () => {
    it('wraps into (-π, π]', () => {
        expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
        expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI);
        expect(wrapAngle(0.5)).toBeCloseTo(0.5);
    });
});

describe('advanceAlongPath', () => {
    it('moves exactly the requested distance along the polyline', () => {
        const pos = { x: 0, z: 0 };
        const points = [{ x: 0, z: 0 }, { x: 3, z: 0 }];
        const idx = advanceAlongPath(points, 0, pos, 1.25);
        expect(pos.x).toBeCloseTo(1.25);
        expect(pos.z).toBeCloseTo(0);
        expect(idx).toBe(1); // consumed the zero-distance first waypoint
    });

    it('turns the corner mid-step without losing distance', () => {
        const pos = { x: 0, z: 0 };
        const points = [{ x: 2, z: 0 }, { x: 2, z: 5 }];
        advanceAlongPath(points, 0, pos, 3);
        expect(pos.x).toBeCloseTo(2);
        expect(pos.z).toBeCloseTo(1);
    });

    it('stops on the final waypoint and reports the path consumed', () => {
        const pos = { x: 0, z: 0 };
        const points = [{ x: 2, z: 0 }];
        const idx = advanceAlongPath(points, 0, pos, 99);
        expect(pos).toEqual({ x: 2, z: 0 });
        expect(idx).toBe(1);
    });
});

describe('roundCorners', () => {
    const free = gridFrom(['...', '...', '...']);

    it('passes straight paths through untouched', () => {
        const pts = [{ x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 }];
        expect(roundCorners(free, pts, 0.35)).toEqual(pts);
    });

    it('replaces a 90° corner with a subdivided arc', () => {
        const pts = [{ x: 0.5, z: 2.5 }, { x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 }];
        const out = roundCorners(free, pts, 0.5);
        expect(out.length).toBeGreaterThan(3);
        expect(out[0]).toEqual(pts[0]);
        expect(out[out.length - 1]).toEqual(pts[2]);
        // the sharp corner vertex itself is gone…
        expect(out.some((p) => p.x === 0.5 && p.z === 0.5)).toBe(false);
        // …and every arc segment direction change is gentler than the original 90°
        for (let i = 2; i < out.length; i++) {
            const a = Math.atan2(out[i - 1].z - out[i - 2].z, out[i - 1].x - out[i - 2].x);
            const b = Math.atan2(out[i].z - out[i - 1].z, out[i].x - out[i - 1].x);
            expect(Math.abs(wrapAngle(b - a))).toBeLessThan(Math.PI / 4);
        }
    });

    it('clamps the radius to half of short segments (adjacent corners never overlap)', () => {
        const pts = [
            { x: 0.5, z: 0.5 }, { x: 1.5, z: 0.5 }, { x: 1.5, z: 1.5 }, { x: 0.5, z: 1.5 }
        ];
        const out = roundCorners(free, pts, 99);
        expect(out[0]).toEqual(pts[0]);
        expect(out[out.length - 1]).toEqual(pts[3]);
        // offsets from consecutive corners meet at most at the segment midpoint
        for (let i = 1; i < out.length; i++) {
            const d = Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
            expect(d).toBeLessThanOrEqual(1 + 1e-9);
        }
    });

    it('keeps the sharp corner when the arc would cross a blocked cell', () => {
        const grid = gridFrom(['...', '#..', '...']);
        // the wide arc from (0.5,1.5) toward (1.5,0.5) starts inside the
        // blocked cell (0,1), so the corner must survive un-rounded
        const pts = [{ x: 0.5, z: 2.5 }, { x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 }];
        const out = roundCorners(grid, pts, 1.0);
        expect(out).toEqual(pts);
    });
});

describe('sampleGoal', () => {
    const grid = gridFrom(EMPTY_10x10);
    const list = [...grid.blocked.keys()]; // all cells reachable

    it('honors the goal box constraint', () => {
        const rng = makeRng();
        for (let i = 0; i < 30; i++) {
            const g = sampleGoal(grid, list, rng, {
                from: { x: 0.5, z: 0.5 }, minDist: 0, avoid: [], avoidRadius: 0,
                box: { minX: 0, maxX: 5, minZ: 0, maxZ: 10 }
            });
            expect(g.cx).toBeLessThan(5);
        }
    });

    it('keeps clear of avoided points', () => {
        const rng = makeRng(7);
        for (let i = 0; i < 30; i++) {
            const g = sampleGoal(grid, list, rng, {
                from: { x: 0.5, z: 0.5 }, minDist: 0,
                avoid: [{ x: 5, z: 5 }], avoidRadius: 4, box: null
            });
            const { x, z } = cellToWorld(grid, g.cx, g.cz);
            expect(Math.hypot(x - 5, z - 5)).toBeGreaterThanOrEqual(4);
        }
    });

    it('relaxes minDist when the region is too small to satisfy it', () => {
        const tiny = gridFrom(['..']);
        const g = sampleGoal(tiny, [0, 1], makeRng(), {
            from: { x: 0.5, z: 0.5 }, minDist: 50, avoid: [], avoidRadius: 0, box: null
        });
        expect(g).not.toBeNull();
    });

    it('returns null for an empty reachable list', () => {
        expect(sampleGoal(grid, [], makeRng(), {
            from: { x: 0, z: 0 }, minDist: 0, avoid: [], avoidRadius: 0, box: null
        })).toBeNull();
    });

    it('prefers goals roughly ahead of the heading', () => {
        const rng = makeRng(11);
        for (let i = 0; i < 30; i++) {
            const from = { x: 5, z: 5 };
            const g = sampleGoal(grid, list, rng, {
                from, minDist: 1, heading: 0, // facing +x
                avoid: [], avoidRadius: 0, box: null
            });
            const { x, z } = cellToWorld(grid, g.cx, g.cz);
            const dist = Math.hypot(x - from.x, z - from.z);
            expect((x - from.x) / dist).toBeGreaterThanOrEqual(0.2);
        }
    });
});

describe('DemoWander', () => {
    it('spawns orbCount orbs, the second clear of the first', () => {
        const grid = gridFrom(EMPTY_10x10);
        const params = makeParams();
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng());
        w.reset(new Vec3(5, 0, 5));
        expect(w.states).toHaveLength(2);
        const [a, b] = w.states;
        expect(Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z))
            .toBeGreaterThanOrEqual(params.source.demo.avoidRadius);
    });

    it('snaps a primary position inside an obstacle to a free cell', () => {
        const grid = gridFrom([
            '.....',
            '..#..',
            '.....'
        ]);
        const w = new DemoWander(grid, makeParams(), boundsFor(grid), makeRng());
        w.reset(new Vec3(2.5, 0, 1.5)); // center of the blocked cell
        const c = worldToCell(grid, w.states[0].pos.x, w.states[0].pos.z);
        expect(isBlocked(grid, c.cx, c.cz)).toBe(false);
    });

    it('keeps every orb on free cells while wandering an obstacle course', () => {
        const grid = gridFrom([
            '..........',
            '...####...',
            '...####...',
            '..........',
            '..........'
        ]);
        const w = new DemoWander(grid, makeParams(), boundsFor(grid), makeRng(99));
        w.reset(new Vec3(0.5, 0, 0.5));
        for (let step = 0; step < 2000; step++) {
            const targets = w.update(1 / 60);
            for (const t of targets) {
                const c = worldToCell(grid, t.x, t.z);
                expect(isBlocked(grid, c.cx, c.cz)).toBe(false);
            }
        }
        // and they actually moved
        expect(w.states[0].goal).not.toBeNull();
    });

    it('moves smoothly: bounded step length and never doubles back', () => {
        const grid = gridFrom(EMPTY_10x10);
        const params = makeParams();
        params.source.demo.orbCount = 1;
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng(5));
        w.reset(new Vec3(5, 0, 5));
        const dt = 1 / 60;
        const speed = params.source.demoSpeed;
        // worst per-frame turn: a forward-biased goal transition (heading·dir
        // ≥ AHEAD_DOT = 0.2 → ≤ ~78°); path corners are subdivided far finer
        const maxTurn = Math.acos(0.2) + 0.05;
        let prev = w.states[0].pos.clone();
        let prevDir = null;
        for (let f = 0; f < 3000; f++) {
            w.update(dt);
            const p = w.states[0].pos;
            const dx = p.x - prev.x;
            const dz = p.z - prev.z;
            const step = Math.hypot(dx, dz);
            expect(step).toBeLessThanOrEqual(speed * dt + 1e-9);
            if (step > 1e-9) {
                const dir = Math.atan2(dz, dx);
                if (prevDir !== null) {
                    expect(Math.abs(wrapAngle(dir - prevDir))).toBeLessThanOrEqual(maxTurn);
                }
                prevDir = dir;
            } else {
                // a pause (deliberate stop-and-turn) resets the continuity check
                prevDir = null;
            }
            prev.copy(p);
        }
    });

    it('never pauses to turn around at a dead end — chains a reversal instead', () => {
        // a 1-wide dead-end corridor forces repeated ~180° reversals
        const grid = gridFrom([
            '#########',
            '#.......#',
            '#########'
        ]);
        const params = makeParams();
        params.source.demo.orbCount = 1;
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng(7));
        w.reset(new Vec3(1.5, 0, 1.5));
        const dt = 1 / 60;
        const speed = params.source.demoSpeed;
        let travelled = 0;
        for (let f = 0; f < 3000; f++) {
            const before = w.states[0].pos.clone();
            w.update(dt);
            travelled += Math.hypot(w.states[0].pos.x - before.x, w.states[0].pos.z - before.z);
            expect(w.states[0].idle).toBe(0); // no stop-and-turn pause, even at the dead ends
        }
        // constant motion: (almost) the full theoretical distance covered,
        // not stalled out waiting through 0.5s pauses at each reversal
        expect(travelled).toBeGreaterThan(speed * dt * 3000 * 0.95);
    });

    it("plans the second orb around the first orb's avoid disc", () => {
        const grid = gridFrom(EMPTY_10x10);
        const params = makeParams();
        params.source.demo.avoidRadius = 1.5;
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng());
        w.reset(new Vec3(5.5, 0, 2.5)); // orb 0 parked mid-grid
        const overlay = w._avoidOverlay(1);
        expect(overlay.size).toBeGreaterThan(0);
        // avoidance is mutual: orb 0 gets an overlay around orb 1 too
        expect(w._avoidOverlay(0).size).toBeGreaterThan(0);
        const path = findPath(grid, { cx: 0, cz: 2 }, { cx: 9, cz: 2 }, overlay);
        expect(path).not.toBeNull();
        const p0 = w.states[0].pos;
        for (const c of path) {
            const { x, z } = cellToWorld(grid, c.cx, c.cz);
            expect(Math.hypot(x - p0.x, z - p0.z)).toBeGreaterThan(params.source.demo.avoidRadius);
        }
    });

    it('detects a higher-priority orb on the remaining path', () => {
        const grid = gridFrom(EMPTY_10x10);
        const params = makeParams();
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng());
        w.reset(new Vec3(5.5, 0, 5.5));
        const s = w.states[1];
        s.pos.set(0.5, 0, 5.5);
        s.path = [new Vec3(9.5, 0, 5.5)]; // straight through orb 0
        s.waypointIdx = 0;
        expect(w._pathConflicts(s, 1)).toBe(true);
        s.path = [new Vec3(0.5, 0, 0.5)]; // well clear of orb 0
        expect(w._pathConflicts(s, 1)).toBe(false);
    });

    it('constrains goals to the wall-peel box only while cutaway is engaged', () => {
        const grid = gridFrom(EMPTY_10x10);
        const params = makeParams();
        params.cutaway.wallPeels.xPos = 6; // peel away the +X side of the room
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng(3));
        w.reset(new Vec3(1.5, 0, 5.5), true);
        for (let step = 0; step < 500; step++) w.update(1 / 60, true);
        for (const s of w.states) {
            expect(s.goal).not.toBeNull();
            const { x } = cellToWorld(grid, s.goal.cx, s.goal.cz);
            expect(x).toBeLessThanOrEqual(boundsFor(grid).center.x + boundsFor(grid).halfExtents.x - 6);
        }
    });

    it('ignores the wall-peel box when cutaway is not engaged', () => {
        const grid = gridFrom(EMPTY_10x10);
        const params = makeParams();
        params.cutaway.wallPeels.xPos = 6; // would peel away the +X side, if engaged
        const w = new DemoWander(grid, params, boundsFor(grid), makeRng(3));
        w.reset(new Vec3(1.5, 0, 5.5)); // cutOn defaults to false
        for (let step = 0; step < 500; step++) w.update(1 / 60);
        const peelLimit = boundsFor(grid).center.x + boundsFor(grid).halfExtents.x - 6;
        expect(w.states.some((s) => cellToWorld(grid, s.goal.cx, s.goal.cz).x > peelLimit)).toBe(true);
    });

    it('setGrid replans in place from where the orbs stand', () => {
        const grid = gridFrom(EMPTY_10x10);
        const w = new DemoWander(grid, makeParams(), boundsFor(grid), makeRng());
        w.reset(new Vec3(5.5, 0, 5.5));
        for (let step = 0; step < 100; step++) w.update(1 / 60);
        const before = w.states[0].pos.clone();
        w.setGrid(gridFrom(EMPTY_10x10));
        expect(w.states).toHaveLength(2);
        expect(w.states[0].pos.x).toBeCloseTo(before.x);
        expect(w.states[0].pos.z).toBeCloseTo(before.z);
    });
});
