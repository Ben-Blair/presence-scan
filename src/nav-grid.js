// 2D occupancy grid on the floor (XZ) plane, derived entirely from the gaussian
// splat centers (`buildNavGridFromColumns`) so obstacles match the *visible*
// scan by construction — the collision mesh is not involved. A cell is blocked
// when its column holds a *grounded* solid that reaches the orb's height: the
// lowest occupied vertical bin sits near the floor and a contiguous occupied
// run rises to `reachHeight`. That rejects thin floor speckle (never rises) and
// wall-hung clutter floating above the floor (the orb passes under it), and
// keeps the footprint tight to the real object. A morphological close
// (`closeGaps`) then bridges small holes left by sparse wall coverage so the
// walkable flood-fill can't leak past a gap in the scan, and finally blocked
// cells are dilated by the orb's clearance radius so the planner can treat the
// orb as a point. The whole module is pure and unit-testable.

/**
 * @typedef {Object} NavGrid
 * @property {number} cols - cell count along X
 * @property {number} rows - cell count along Z
 * @property {number} cell - cell size (m)
 * @property {number} minX - world X of the grid's min corner
 * @property {number} minZ - world Z of the grid's min corner
 * @property {Uint8Array} blocked - cols*rows occupancy flags (1 = blocked)
 * @property {number | null} floorY - world y of the walkable plane this grid
 *   was built against (the debug overlay draws here), or null if unknown
 */

/** Flat index of cell (cx, cz). No bounds check — pair with {@link isBlocked}. */
export function cellIndex(grid, cx, cz) {
    return cz * grid.cols + cx;
}

/**
 * Whether cell (cx, cz) is untraversable: out of bounds, occupied, or listed
 * in the optional `overlay` of extra blocked cell indices (used for dynamic
 * obstacles like the other orb).
 *
 * @param {NavGrid} grid
 * @param {number} cx
 * @param {number} cz
 * @param {Set<number>} [overlay]
 * @returns {boolean}
 */
export function isBlocked(grid, cx, cz, overlay) {
    if (cx < 0 || cz < 0 || cx >= grid.cols || cz >= grid.rows) return true;
    const idx = cz * grid.cols + cx;
    if (grid.blocked[idx]) return true;
    return overlay ? overlay.has(idx) : false;
}

/** World position → containing cell (unclamped; may be out of bounds). */
export function worldToCell(grid, x, z) {
    return {
        cx: Math.floor((x - grid.minX) / grid.cell),
        cz: Math.floor((z - grid.minZ) / grid.cell)
    };
}

/** Cell → world position of its center. */
export function cellToWorld(grid, cx, cz) {
    return {
        x: grid.minX + (cx + 0.5) * grid.cell,
        z: grid.minZ + (cz + 0.5) * grid.cell
    };
}

/** Offsets of a euclidean disc of `radiusCells` (may be fractional), origin excluded. */
function discOffsets(radiusCells) {
    const r = Math.ceil(radiusCells);
    const r2 = radiusCells * radiusCells;
    /** @type {{dx:number, dz:number}[]} */
    const offsets = [];
    for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
            if ((dx !== 0 || dz !== 0) && dx * dx + dz * dz <= r2) offsets.push({ dx, dz });
        }
    }
    return offsets;
}

/** Dilate blocked cells by a euclidean disc of `radiusCells` (may be fractional). */
function dilate(grid, radiusCells) {
    const { cols, rows, blocked } = grid;
    const offsets = discOffsets(radiusCells);
    const src = blocked.slice();
    for (let cz = 0; cz < rows; cz++) {
        for (let cx = 0; cx < cols; cx++) {
            if (!src[cz * cols + cx]) continue;
            for (const { dx, dz } of offsets) {
                const nx = cx + dx;
                const nz = cz + dz;
                if (nx >= 0 && nz >= 0 && nx < cols && nz < rows) blocked[nz * cols + nx] = 1;
            }
        }
    }
}

/**
 * Erode blocked cells by a euclidean disc of `radiusCells`: a cell survives only
 * if every disc neighbor is also blocked. Out-of-bounds neighbors count as
 * blocked, so eroding never nibbles the grid's outer boundary (walls that hug
 * the edge stay put). The dual of {@link dilate}.
 */
function erode(grid, radiusCells) {
    const { cols, rows, blocked } = grid;
    const offsets = discOffsets(radiusCells);
    const src = blocked.slice();
    for (let cz = 0; cz < rows; cz++) {
        for (let cx = 0; cx < cols; cx++) {
            if (!src[cz * cols + cx]) continue;
            for (const { dx, dz } of offsets) {
                const nx = cx + dx;
                const nz = cz + dz;
                if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue; // OOB = blocked
                if (!src[nz * cols + nx]) { blocked[cz * cols + cx] = 0; break; }
            }
        }
    }
}

/**
 * Morphological close: {@link dilate} then {@link erode} by the same radius.
 * Bridges gaps and fills holes up to `2·radiusCells` wide (e.g. a sparse patch
 * in a scanned wall) while restoring the true outer faces, so obstacle
 * footprints stay tight. Used to seal wall gaps the flood-fill would leak past.
 */
function closeGaps(grid, radiusCells) {
    dilate(grid, radiusCells);
    erode(grid, radiusCells);
}

/**
 * Estimate the world-space floor height from gaussian splat centers: the floor
 * is the lowest large horizontal surface, so histogram world-y (5 cm bins) of
 * the centers inside the room's XZ bounds and take the lowest bin whose count
 * reaches `minPeakRatio` of the biggest bin. Sparse under-floor floaters and
 * sloping outdoor spill smear across many bins and never qualify; the ceiling
 * can out-mass the floor, which is why "biggest bin" alone would be wrong.
 * The picked bin is refined by the count-weighted mean of itself ±1 neighbor.
 *
 * @param {Float32Array} centers - xyz triples in splat-local space
 * @param {ArrayLike<number>} matrix - column-major 4x4 local→world transform
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number,
 *          minPeakRatio?:number}} bounds
 * @returns {number | null} world floor y, or null if no centers land in bounds
 */
export function estimateFloorY(centers, matrix, bounds) {
    const m = matrix;
    const BIN = 0.05;
    const Y_MIN = -10;
    const bins = new Int32Array(400); // covers world y in [-10, 10)
    let total = 0;
    for (let i = 0; i < centers.length; i += 3) {
        const x = centers[i], y = centers[i + 1], z = centers[i + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        if (wx < bounds.minX || wx > bounds.maxX) continue;
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (wz < bounds.minZ || wz > bounds.maxZ) continue;
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const bin = Math.floor((wy - Y_MIN) / BIN);
        if (bin < 0 || bin >= bins.length) continue;
        bins[bin]++;
        total++;
    }
    if (!total) return null;
    let max = 0;
    for (const n of bins) max = Math.max(max, n);
    const threshold = max * (bounds.minPeakRatio ?? 0.2);
    for (let b = 0; b < bins.length; b++) {
        if (bins[b] < threshold) continue;
        // refine within the bin and its neighbors (kills the 5cm quantization)
        let sum = 0;
        let count = 0;
        for (let k = Math.max(0, b - 1); k <= Math.min(bins.length - 1, b + 1); k++) {
            sum += bins[k] * (Y_MIN + (k + 0.5) * BIN);
            count += bins[k];
        }
        return sum / count;
    }
    return null; // unreachable while total > 0, but keeps the type honest
}

/**
 * Build an occupancy grid from gaussian splat centers by their per-column
 * *vertical extent*. For each XZ cell, centers are binned by height above the
 * floor (`floorY`) into `vBin`-tall bins up to `reachHeight`. A cell is blocked
 * when its column holds a *grounded* solid that reaches the orb's height:
 *
 *   - a bin is *occupied* when it holds ≥ `minCount` centers (density gate that
 *     rejects sparse floater/speckle splats);
 *   - the lowest occupied bin must be *grounded* — its base within `groundGap`
 *     of the floor — else the column is floating wall-hung clutter the orb
 *     passes under;
 *   - from there a contiguous occupied run (tolerating a single empty bin for
 *     scan holes) must *reach* `reachHeight`, else it's thin floor speckle.
 *
 * Small gaps left by sparse wall coverage are then closed (`gapBridge` meters)
 * so the walkable flood-fill can't leak through a hole in the scan, and finally
 * blocked cells are dilated by `inflate` meters (clearance). Centers are
 * transformed local→world inline — no intermediate copy of the (large) array.
 *
 * @param {Float32Array} centers - xyz triples in splat-local space
 * @param {ArrayLike<number>} matrix - column-major 4x4 local→world transform
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, cell:number,
 *          floorY:number, reachHeight:number, groundGap:number, vBin:number,
 *          minCount:number, gapBridge:number, inflate:number}} opts
 * @returns {NavGrid}
 */
export function buildNavGridFromColumns(centers, matrix, opts) {
    const m = matrix;
    const { minX, minZ, cell, floorY, vBin, reachHeight, groundGap, minCount } = opts;
    const cols = Math.max(1, Math.ceil((opts.maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((opts.maxZ - minZ) / cell));
    // one extra bin so a run can be seen to reach the top of [floor, reachHeight]
    const nBins = Math.max(1, Math.ceil(reachHeight / vBin)) + 1;
    const yTop = floorY + nBins * vBin;
    const binCounts = new Uint32Array(cols * rows * nBins); // wall cells hold many
    for (let i = 0; i < centers.length; i += 3) {
        const x = centers[i], y = centers[i + 1], z = centers[i + 2];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        if (wy < floorY || wy >= yTop) continue;
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cx = Math.floor((wx - minX) / cell);
        if (cx < 0 || cx >= cols) continue;
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const cz = Math.floor((wz - minZ) / cell);
        if (cz < 0 || cz >= rows) continue;
        const b = Math.floor((wy - floorY) / vBin);
        binCounts[(cz * cols + cx) * nBins + b]++;
    }
    const groundBins = groundGap / vBin;       // grounded base must be at/below this bin
    const reachBins = reachHeight / vBin;       // run must extend to at least this bin
    const blocked = new Uint8Array(cols * rows);
    for (let c = 0; c < cols * rows; c++) {
        const base = c * nBins;
        // lowest occupied bin
        let lo = -1;
        for (let b = 0; b < nBins; b++) {
            if (binCounts[base + b] >= minCount) { lo = b; break; }
        }
        if (lo < 0 || lo > groundBins) continue; // empty, or floating clutter
        // extend a contiguous occupied run upward, tolerating one empty bin
        let top = lo;
        let gap = 0;
        for (let b = lo + 1; b < nBins; b++) {
            if (binCounts[base + b] >= minCount) { top = b; gap = 0; }
            else if (++gap > 1) break;
        }
        if (top + 1 >= reachBins) blocked[c] = 1; // run reaches the orb's height
    }
    const grid = { cols, rows, cell, minX, minZ, blocked, floorY };
    if (opts.gapBridge > 0) closeGaps(grid, opts.gapBridge / cell);
    if (opts.inflate > 0) dilate(grid, opts.inflate / cell);
    return grid;
}

/**
 * Empty (all-free) grid over the given XZ bounds — used when the engine kept no
 * CPU splat centers, so demo mode still runs with no obstacles.
 *
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, cell:number,
 *          floorY?:number}} opts
 * @returns {NavGrid}
 */
export function emptyGrid(opts) {
    const { minX, minZ, cell } = opts;
    const cols = Math.max(1, Math.ceil((opts.maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((opts.maxZ - minZ) / cell));
    return { cols, rows, cell, minX, minZ, blocked: new Uint8Array(cols * rows), floorY: opts.floorY ?? null };
}

/**
 * Flood-fill (4-connected) the free region containing (cx, cz). Returns a
 * per-cell reachability mask plus a flat list of reachable cell indices for
 * O(1) uniform goal sampling. A blocked start yields an empty region.
 *
 * @param {NavGrid} grid
 * @param {number} cx
 * @param {number} cz
 * @returns {{ mask: Uint8Array, list: number[] }}
 */
export function computeReachable(grid, cx, cz) {
    const mask = new Uint8Array(grid.cols * grid.rows);
    /** @type {number[]} */
    const list = [];
    if (isBlocked(grid, cx, cz)) return { mask, list };
    const queue = [cellIndex(grid, cx, cz)];
    mask[queue[0]] = 1;
    while (queue.length) {
        const idx = queue.pop();
        list.push(idx);
        const x = idx % grid.cols;
        const z = (idx - x) / grid.cols;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const nz = z + dz;
            if (isBlocked(grid, nx, nz)) continue;
            const nIdx = nz * grid.cols + nx;
            if (!mask[nIdx]) {
                mask[nIdx] = 1;
                queue.push(nIdx);
            }
        }
    }
    return { mask, list };
}

/**
 * Nearest free cell to (cx, cz) by BFS ring expansion (the start is clamped
 * into the grid first). Returns null only if every cell is blocked.
 *
 * @param {NavGrid} grid
 * @param {number} cx
 * @param {number} cz
 * @returns {{cx:number, cz:number} | null}
 */
export function nearestFreeCell(grid, cx, cz) {
    const sx = Math.min(Math.max(cx, 0), grid.cols - 1);
    const sz = Math.min(Math.max(cz, 0), grid.rows - 1);
    if (!isBlocked(grid, sx, sz)) return { cx: sx, cz: sz };
    const visited = new Uint8Array(grid.cols * grid.rows);
    let ring = [cellIndex(grid, sx, sz)];
    visited[ring[0]] = 1;
    while (ring.length) {
        /** @type {number[]} */
        const next = [];
        for (const idx of ring) {
            const x = idx % grid.cols;
            const z = (idx - x) / grid.cols;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx;
                const nz = z + dz;
                if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
                const nIdx = nz * grid.cols + nx;
                if (visited[nIdx]) continue;
                visited[nIdx] = 1;
                if (!grid.blocked[nIdx]) return { cx: nx, cz: nz };
                next.push(nIdx);
            }
        }
        ring = next;
    }
    return null;
}
