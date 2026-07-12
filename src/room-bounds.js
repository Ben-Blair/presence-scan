// Robust world-space room bounds from gaussian splat centers. The engine's own
// `resource.aabb` is a raw min/max over every splat, so a handful of far-flung
// floater points (common in 3DGS reconstructions) can bloat it to many times
// the room's real size. This estimates bounds the same way `estimateFloorY`
// (nav-grid.js) estimates the floor: histogram each axis, then take the
// extent of bins that hold a real share of the density — sparse outlier bins
// fall below the threshold and are excluded regardless of how far out they sit.

/**
 * @typedef {{x:number, y:number, z:number}} Vec3Like
 * @typedef {{min: Vec3Like, max: Vec3Like}} RoomBounds
 */

/**
 * Estimate world-space room bounds from splat centers, rejecting sparse
 * floater outliers per axis. Each axis is histogrammed independently over its
 * own raw min/max span; bins below `densityRatio` of that axis's densest bin
 * are treated as outlier tail and excluded from the returned extent. Falls
 * back to the full raw span for an axis if no bin clears the threshold (e.g.
 * uniformly sparse data), so the result is never an inverted/empty box.
 *
 * @param {Float32Array} centers - xyz triples in splat-local space
 * @param {ArrayLike<number>} matrix - column-major 4x4 local→world transform
 * @param {{densityRatio?: number, bins?: number}} [opts]
 * @returns {RoomBounds | null} world-space bounds, or null if centers is empty
 */
export function estimateRoomBounds(centers, matrix, opts = {}) {
    const bins = opts.bins ?? 512;
    const densityRatio = opts.densityRatio ?? 0.02;
    if (centers.length === 0) return null;
    const m = matrix;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < centers.length; i += 3) {
        const x = centers[i], y = centers[i + 1], z = centers[i + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
    }

    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const spanZ = Math.max(maxZ - minZ, 1e-6);
    const hx = new Uint32Array(bins);
    const hy = new Uint32Array(bins);
    const hz = new Uint32Array(bins);
    for (let i = 0; i < centers.length; i += 3) {
        const x = centers[i], y = centers[i + 1], z = centers[i + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        hx[Math.min(bins - 1, Math.floor((wx - minX) / spanX * bins))]++;
        hy[Math.min(bins - 1, Math.floor((wy - minY) / spanY * bins))]++;
        hz[Math.min(bins - 1, Math.floor((wz - minZ) / spanZ * bins))]++;
    }

    /**
     * Extent of bins whose count clears `densityRatio` of the axis's peak bin.
     * The peak bin itself always clears its own threshold, so `first`/`last`
     * always find at least that bin — the walk can't invert past each other.
     */
    const trim = (hist, lo, span) => {
        let peak = 0;
        for (const c of hist) peak = Math.max(peak, c);
        const threshold = peak * densityRatio;
        let first = 0;
        while (hist[first] < threshold) first++;
        let last = bins - 1;
        while (hist[last] < threshold) last--;
        return { min: lo + (first / bins) * span, max: lo + ((last + 1) / bins) * span };
    };

    const rx = trim(hx, minX, spanX);
    const ry = trim(hy, minY, spanY);
    const rz = trim(hz, minZ, spanZ);
    return {
        min: { x: rx.min, y: ry.min, z: rz.min },
        max: { x: rx.max, y: ry.max, z: rz.max }
    };
}
