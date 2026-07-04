// 2D occupancy grid on the floor (XZ) plane. Primary source: the gaussian
// splat centers themselves (`buildNavGridFromPoints`) — cells holding enough
// splats inside the obstacle height band are blocked, so the grid matches the
// *visible* scan by construction. Fallback source: collision-mesh triangles
// (`buildNavGrid`). Blocked cells are dilated by the orb's clearance radius so
// the planner can treat the orb as a point. Everything except
// `extractWorldTriangles` is pure and unit-testable.

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

/**
 * @typedef {Object} TriangleMesh
 * @property {Float32Array} positions - world-space xyz triples
 * @property {Uint32Array | null} indices - triangle indices, or null if the
 *   positions are already sequential triangles
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

/**
 * Rasterize world-space triangle meshes into an occupancy grid over the given
 * XZ bounds. A triangle marks a cell when its y-range intersects
 * [yMin, yMax] (the obstacle height band — floor and ceiling geometry filtered
 * out) and its XZ projection overlaps the cell (exact SAT test, so thin walls
 * can't slip between cell centers). Blocked cells are then dilated by
 * `inflate` meters so path planning can treat the agent as a point.
 *
 * @param {TriangleMesh[]} meshes
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, cell:number,
 *          yMin:number, yMax:number, inflate:number, floorY?:number}} opts
 * @returns {NavGrid}
 */
export function buildNavGrid(meshes, opts) {
    const { minX, minZ, cell, yMin, yMax } = opts;
    const cols = Math.max(1, Math.ceil((opts.maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((opts.maxZ - minZ) / cell));
    const blocked = new Uint8Array(cols * rows);
    const grid = { cols, rows, cell, minX, minZ, blocked, floorY: opts.floorY ?? null };

    for (const mesh of meshes) {
        const pos = mesh.positions;
        const idx = mesh.indices;
        const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
        for (let t = 0; t < triCount; t++) {
            const i0 = (idx ? idx[t * 3] : t * 3) * 3;
            const i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3;
            const i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3;
            const ay = pos[i0 + 1], by = pos[i1 + 1], cy = pos[i2 + 1];
            // skip triangles entirely outside the obstacle height band
            if (Math.min(ay, by, cy) > yMax || Math.max(ay, by, cy) < yMin) continue;
            rasterizeTriangleXZ(grid,
                pos[i0], pos[i0 + 2],
                pos[i1], pos[i1 + 2],
                pos[i2], pos[i2 + 2]);
        }
    }

    if (opts.inflate > 0) dilate(grid, opts.inflate / cell);
    return grid;
}

/** Mark every cell whose XZ square overlaps triangle (a, b, c) as blocked. */
function rasterizeTriangleXZ(grid, ax, az, bx, bz, cx, cz) {
    const { cols, rows, cell, minX, minZ } = grid;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / cell));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx, cx) - minX) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - minZ) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(az, bz, cz) - minZ) / cell));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            if (grid.blocked[r * cols + c]) continue;
            const x0 = minX + c * cell;
            const z0 = minZ + r * cell;
            if (triangleOverlapsRect(ax, az, bx, bz, cx, cz, x0, z0, x0 + cell, z0 + cell)) {
                grid.blocked[r * cols + c] = 1;
            }
        }
    }
}

/**
 * 2D SAT triangle-vs-rect overlap. The rect's own axes are guaranteed
 * overlapping by the caller's AABB range loop, so only the triangle's three
 * edge normals can separate. Degenerate (collinear) triangles — e.g. vertical
 * wall faces seen top-down — find no separating edge and conservatively mark
 * every cell in their (thin) XZ AABB.
 */
function triangleOverlapsRect(ax, az, bx, bz, cx, cz, rx0, rz0, rx1, rz1) {
    return !edgeSeparates(ax, az, bx, bz, cx, cz, rx0, rz0, rx1, rz1) &&
           !edgeSeparates(bx, bz, cx, cz, ax, az, rx0, rz0, rx1, rz1) &&
           !edgeSeparates(cx, cz, ax, az, bx, bz, rx0, rz0, rx1, rz1) ;
}

/** Whether edge (p→q)'s normal separates the rect from the triangle's third vertex o. */
function edgeSeparates(px, pz, qx, qz, ox, oz, rx0, rz0, rx1, rz1) {
    const nx = -(qz - pz);
    const nz = qx - px;
    const triSide = nx * (ox - px) + nz * (oz - pz);
    if (triSide === 0) return false; // degenerate/collinear — this axis can't separate
    const d0 = nx * (rx0 - px) + nz * (rz0 - pz);
    const d1 = nx * (rx1 - px) + nz * (rz0 - pz);
    const d2 = nx * (rx0 - px) + nz * (rz1 - pz);
    const d3 = nx * (rx1 - px) + nz * (rz1 - pz);
    return triSide > 0
        ? (d0 < 0 && d1 < 0 && d2 < 0 && d3 < 0)
        : (d0 > 0 && d1 > 0 && d2 > 0 && d3 > 0);
}

/** Dilate blocked cells by a euclidean disc of `radiusCells` (may be fractional). */
function dilate(grid, radiusCells) {
    const { cols, rows, blocked } = grid;
    const r = Math.ceil(radiusCells);
    const r2 = radiusCells * radiusCells;
    /** @type {{dx:number, dz:number}[]} */
    const offsets = [];
    for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
            if ((dx !== 0 || dz !== 0) && dx * dx + dz * dz <= r2) offsets.push({ dx, dz });
        }
    }
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
 * Rasterize gaussian splat centers into an occupancy grid: a cell is blocked
 * when at least `minCount` centers land in it inside the [yMin, yMax] obstacle
 * height band (the count threshold rejects stray floater splats). Centers are
 * transformed local→world inline — no intermediate copy of the (large) array.
 * Blocked cells are then dilated by `inflate` meters, as with the mesh path.
 *
 * @param {Float32Array} centers - xyz triples in splat-local space
 * @param {ArrayLike<number>} matrix - column-major 4x4 local→world transform
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, cell:number,
 *          yMin:number, yMax:number, inflate:number, minCount:number,
 *          floorY?:number}} opts
 * @returns {NavGrid}
 */
export function buildNavGridFromPoints(centers, matrix, opts) {
    const m = matrix;
    const { minX, minZ, cell, yMin, yMax } = opts;
    const cols = Math.max(1, Math.ceil((opts.maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((opts.maxZ - minZ) / cell));
    const counts = new Uint32Array(cols * rows); // wall cells can hold >64k splats
    for (let i = 0; i < centers.length; i += 3) {
        const x = centers[i], y = centers[i + 1], z = centers[i + 2];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        if (wy < yMin || wy > yMax) continue;
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cx = Math.floor((wx - minX) / cell);
        if (cx < 0 || cx >= cols) continue;
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const cz = Math.floor((wz - minZ) / cell);
        if (cz < 0 || cz >= rows) continue;
        counts[cz * cols + cx]++;
    }
    const blocked = new Uint8Array(cols * rows);
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] >= opts.minCount) blocked[i] = 1;
    }
    const grid = { cols, rows, cell, minX, minZ, blocked, floorY: opts.floorY ?? null };
    if (opts.inflate > 0) dilate(grid, opts.inflate / cell);
    return grid;
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

/**
 * Pull every render mesh out of an instantiated container entity as flat
 * world-space triangle arrays, before the entity is destroyed. Positions are
 * baked through each mesh instance's world transform.
 *
 * @param {*} entity - an entity hierarchy from `instantiateRenderEntity()`
 * @returns {TriangleMesh[]}
 */
export function extractWorldTriangles(entity) {
    /** @type {TriangleMesh[]} */
    const meshes = [];
    entity.findComponents('render').forEach((render) => {
        render.meshInstances.forEach((mi) => {
            /** @type {number[]} */
            const local = [];
            if (!mi.mesh.getPositions(local)) return;
            /** @type {number[]} */
            const indices = [];
            mi.mesh.getIndices(indices);
            const m = mi.node.getWorldTransform().data; // column-major 4x4
            const positions = new Float32Array(local.length);
            for (let i = 0; i < local.length; i += 3) {
                const x = local[i], y = local[i + 1], z = local[i + 2];
                positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
                positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            }
            meshes.push({ positions, indices: indices.length ? new Uint32Array(indices) : null });
        });
    });
    return meshes;
}
