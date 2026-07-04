// Grid A* over a NavGrid occupancy map, plus the line-of-sight test and
// string-pulling smoother that turn its cell staircase into clean straight
// runs. 8-connected with an octile heuristic and a binary-heap open list;
// diagonal steps are refused when either adjacent orthogonal cell is blocked
// (no corner cutting). Pure — no PlayCanvas imports.

import { cellIndex, isBlocked } from './nav-grid.js';

/** @typedef {import('./nav-grid.js').NavGrid} NavGrid */
/** @typedef {{cx:number, cz:number}} Cell */

const SQRT2 = Math.SQRT2;

/** Octile distance: optimal cost on an 8-connected grid with no obstacles. */
function octile(dx, dz) {
    const ax = Math.abs(dx);
    const az = Math.abs(dz);
    return ax > az ? ax + (SQRT2 - 1) * az : az + (SQRT2 - 1) * ax;
}

/** Binary min-heap of cell indices keyed by f-score (lazy deletion). */
class MinHeap {
    /** @param {Float64Array} f - f-score per cell index */
    constructor(f) {
        this.f = f;
        /** @type {number[]} */
        this.items = [];
    }

    push(idx) {
        const { items, f } = this;
        items.push(idx);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (f[items[parent]] <= f[items[i]]) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }

    pop() {
        const { items, f } = this;
        const top = items[0];
        const last = /** @type {number} */ (items.pop());
        if (items.length) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let min = i;
                if (l < items.length && f[items[l]] < f[items[min]]) min = l;
                if (r < items.length && f[items[r]] < f[items[min]]) min = r;
                if (min === i) break;
                [items[min], items[i]] = [items[i], items[min]];
                i = min;
            }
        }
        return top;
    }

    get size() {
        return this.items.length;
    }
}

// neighbor steps: 4 orthogonal then 4 diagonal (fixed order for determinism)
const STEPS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]
];

/**
 * A* shortest path from `start` to `goal`. Returns the cell path including
 * both endpoints, or null when the goal is blocked or unreachable. The start
 * cell itself is allowed to be blocked (an agent standing inside the inflated
 * clearance region can still plan its way out).
 *
 * @param {NavGrid} grid
 * @param {Cell} start
 * @param {Cell} goal
 * @param {Set<number>} [overlay] - extra blocked cell indices (dynamic obstacles)
 * @returns {Cell[] | null}
 */
export function findPath(grid, start, goal, overlay) {
    if (isBlocked(grid, goal.cx, goal.cz, overlay)) return null;
    if (start.cx === goal.cx && start.cz === goal.cz) return [{ ...start }];
    if (start.cx < 0 || start.cz < 0 || start.cx >= grid.cols || start.cz >= grid.rows) return null;

    const size = grid.cols * grid.rows;
    const g = new Float64Array(size).fill(Infinity);
    const f = new Float64Array(size).fill(Infinity);
    const parent = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const open = new MinHeap(f);

    const startIdx = cellIndex(grid, start.cx, start.cz);
    const goalIdx = cellIndex(grid, goal.cx, goal.cz);
    g[startIdx] = 0;
    f[startIdx] = octile(goal.cx - start.cx, goal.cz - start.cz);
    open.push(startIdx);

    while (open.size) {
        const idx = open.pop();
        if (closed[idx]) continue; // stale duplicate (lazy decrease-key)
        if (idx === goalIdx) return reconstruct(grid, parent, idx);
        closed[idx] = 1;
        const cx = idx % grid.cols;
        const cz = (idx - cx) / grid.cols;

        for (const [dx, dz, cost] of STEPS) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (isBlocked(grid, nx, nz, overlay)) continue;
            // no corner cutting: a diagonal needs both flanking cells free
            if (dx !== 0 && dz !== 0 &&
                (isBlocked(grid, cx + dx, cz, overlay) || isBlocked(grid, cx, cz + dz, overlay))) continue;
            const nIdx = nz * grid.cols + nx;
            if (closed[nIdx]) continue;
            const tentative = g[idx] + cost;
            if (tentative < g[nIdx]) {
                g[nIdx] = tentative;
                f[nIdx] = tentative + octile(goal.cx - nx, goal.cz - nz);
                parent[nIdx] = idx;
                open.push(nIdx);
            }
        }
    }
    return null;
}

/** Walk the parent chain back from the goal into a start→goal cell list. */
function reconstruct(grid, parent, idx) {
    /** @type {Cell[]} */
    const path = [];
    for (let i = idx; i !== -1; i = parent[i]) {
        const cx = i % grid.cols;
        path.push({ cx, cz: (i - cx) / grid.cols });
    }
    return path.reverse();
}

/**
 * Whether the segment between the centers of cells `a` and `b` crosses only
 * free cells. Supercover traversal (Amanatides–Woo): every cell the segment
 * touches is tested, and an exact corner crossing conservatively requires both
 * flanking cells free — so a smoothed segment can never clip a blocked corner.
 *
 * @param {NavGrid} grid
 * @param {Cell} a
 * @param {Cell} b
 * @param {Set<number>} [overlay]
 * @returns {boolean}
 */
export function hasLineOfSight(grid, a, b, overlay) {
    let cx = a.cx;
    let cz = a.cz;
    const dx = b.cx - a.cx;
    const dz = b.cz - a.cz;
    const stepX = Math.sign(dx);
    const stepZ = Math.sign(dz);
    // parametric distance to the next X/Z cell border, starting from the center
    let tMaxX = dx !== 0 ? 0.5 / Math.abs(dx) : Infinity;
    let tMaxZ = dz !== 0 ? 0.5 / Math.abs(dz) : Infinity;
    const tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const tDeltaZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;

    while (cx !== b.cx || cz !== b.cz) {
        if (Math.abs(tMaxX - tMaxZ) < 1e-12) {
            // exact corner: passes between the two flanking cells — need both
            if (isBlocked(grid, cx + stepX, cz, overlay) ||
                isBlocked(grid, cx, cz + stepZ, overlay)) return false;
            cx += stepX;
            cz += stepZ;
            tMaxX += tDeltaX;
            tMaxZ += tDeltaZ;
        } else if (tMaxX < tMaxZ) {
            cx += stepX;
            tMaxX += tDeltaX;
        } else {
            cz += stepZ;
            tMaxZ += tDeltaZ;
        }
        if (isBlocked(grid, cx, cz, overlay)) return false;
    }
    return true;
}

/**
 * String-pull a cell path: greedily extend each segment to the farthest
 * waypoint still in line of sight, dropping the intermediate staircase cells.
 * Endpoints are preserved.
 *
 * @param {NavGrid} grid
 * @param {Cell[]} path
 * @param {Set<number>} [overlay]
 * @returns {Cell[]}
 */
export function smoothPath(grid, path, overlay) {
    if (path.length <= 2) return path.slice();
    const out = [path[0]];
    let anchor = 0;
    while (anchor < path.length - 1) {
        let next = anchor + 1; // adjacent step always reachable (A* produced it)
        for (let j = path.length - 1; j > anchor + 1; j--) {
            if (hasLineOfSight(grid, path[anchor], path[j], overlay)) {
                next = j;
                break;
            }
        }
        out.push(path[next]);
        anchor = next;
    }
    return out;
}
