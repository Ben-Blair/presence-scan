import { describe, it, expect } from 'vitest';
import {
    buildNavGridFromColumns, emptyGrid, estimateFloorY,
    cellIndex, isBlocked, worldToCell, cellToWorld,
    computeReachable, nearestFreeCell
} from '../src/nav-grid.js';

function blockedCells(grid) {
    const out = [];
    for (let cz = 0; cz < grid.rows; cz++) {
        for (let cx = 0; cx < grid.cols; cx++) {
            if (grid.blocked[cz * grid.cols + cx]) out.push([cx, cz]);
        }
    }
    return out;
}

/** A 5x5 m, 1 m-cell NavGrid with the given cells pre-blocked. */
function makeGrid(blocked = []) {
    const cols = 5, rows = 5;
    const b = new Uint8Array(cols * rows);
    for (const [cx, cz] of blocked) b[cz * cols + cx] = 1;
    return { cols, rows, cell: 1, minX: 0, minZ: 0, blocked: b, floorY: null };
}

// column-major 4x4 matrices for the point-based builder
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// the splat entity's 180° X rotation: world y = -local y, world z = -local z
const FLIP_X180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** Pack [x,y,z] triples into a Float32Array of centers. */
function centersOf(...pts) {
    return new Float32Array(pts.flat());
}

/** n copies of point [x,y,z] with tiny deterministic jitter on y. */
function cluster(n, x, y, z, jitter = 0.01) {
    const out = [];
    for (let i = 0; i < n; i++) out.push([x, y + ((i % 3) - 1) * jitter, z]);
    return out;
}

/**
 * `perBin` points in each of the listed vertical `bins` (0.1 m tall, so bin b is
 * centered at 0.1·b + 0.05), stacked over cell-center (x, z). `ysign` flips the
 * height sign for the splat-flip matrix.
 */
function colPts(x, z, bins, perBin = 4, ysign = 1) {
    const out = [];
    for (const b of bins) {
        const y = ysign * (b * 0.1 + 0.05);
        for (let i = 0; i < perBin; i++) out.push([x, y, z]);
    }
    return out;
}

describe('estimateFloorY', () => {
    const XZ = { minX: 0, maxX: 5, minZ: 0, maxZ: 5 };

    it('picks the floor even when the ceiling holds more splats', () => {
        const pts = [
            ...cluster(200, 2, 0.0, 2),   // floor plane
            ...cluster(300, 2, 2.5, 2),   // denser ceiling mass
            ...cluster(3, 2, -0.8, 2),    // sparse under-floor floaters
            ...cluster(3, 2, -1.4, 2)
        ];
        const y = estimateFloorY(centersOf(...pts), IDENTITY, XZ);
        expect(y).toBeCloseTo(0, 1);
    });

    it('ignores dense geometry outside the XZ bounds', () => {
        const pts = [
            ...cluster(500, 9, -1.0, 9),  // driveway-like plane, out of bounds
            ...cluster(100, 2, 0.0, 2)    // in-bounds floor
        ];
        const y = estimateFloorY(centersOf(...pts), IDENTITY, XZ);
        expect(y).toBeCloseTo(0, 1);
    });

    it('applies the local→world matrix (splat flip)', () => {
        // local y = -0.3 → world y = +0.3 under the 180° X flip; local z is
        // mirrored too, so place it at -2.5 to land inside the bounds
        const pts = cluster(100, 2, -0.3, -2.5);
        const y = estimateFloorY(centersOf(...pts), FLIP_X180, XZ);
        expect(y).toBeCloseTo(0.3, 1);
    });

    it('returns null when nothing lands in bounds', () => {
        expect(estimateFloorY(centersOf([9, 0, 9]), IDENTITY, XZ)).toBeNull();
        expect(estimateFloorY(new Float32Array(0), IDENTITY, XZ)).toBeNull();
    });
});

describe('buildNavGridFromColumns', () => {
    // 5x5 m, 1 m cells; floor at y=0, orb reach 0.4 m, grounded within 0.2 m
    const OPTS = {
        minX: 0, maxX: 5, minZ: 0, maxZ: 5, cell: 1,
        floorY: 0, vBin: 0.1, reachHeight: 0.4, groundGap: 0.2,
        minCount: 4, gapBridge: 0, inflate: 0
    };

    it('blocks a grounded column that reaches the orb height', () => {
        const pts = centersOf(...colPts(2.5, 2.5, [0, 1, 2, 3]));
        expect(blockedCells(buildNavGridFromColumns(pts, IDENTITY, OPTS))).toEqual([[2, 2]]);
    });

    it('leaves floating clutter free (orb passes under it)', () => {
        // occupied only well above the floor — no grounded base
        const pts = centersOf(...colPts(2.5, 2.5, [3, 4]));
        expect(blockedCells(buildNavGridFromColumns(pts, IDENTITY, OPTS))).toEqual([]);
    });

    it('leaves thin floor speckle free (never rises to the orb)', () => {
        const pts = centersOf(...colPts(2.5, 2.5, [0]));
        expect(blockedCells(buildNavGridFromColumns(pts, IDENTITY, OPTS))).toEqual([]);
    });

    it('requires minCount splats per bin to count a bin occupied', () => {
        const pts = centersOf(...colPts(2.5, 2.5, [0, 1, 2, 3], 3)); // 3 < minCount
        expect(blockedCells(buildNavGridFromColumns(pts, IDENTITY, OPTS))).toEqual([]);
    });

    it('tolerates a single empty bin in the run but not two', () => {
        const oneGap = centersOf(...colPts(2.5, 2.5, [0, 1, 3])); // bin 2 empty
        expect(blockedCells(buildNavGridFromColumns(oneGap, IDENTITY, OPTS))).toEqual([[2, 2]]);
        const twoGap = centersOf(...colPts(2.5, 2.5, [0, 3])); // bins 1,2 empty
        expect(blockedCells(buildNavGridFromColumns(twoGap, IDENTITY, OPTS))).toEqual([]);
    });

    it('transforms points through the matrix before binning', () => {
        // local (1.5, -h, -3.5) → world (1.5, h, 3.5) under the X flip → cell (1,3)
        const pts = centersOf(...colPts(1.5, -3.5, [0, 1, 2, 3], 4, -1));
        expect(blockedCells(buildNavGridFromColumns(pts, FLIP_X180, OPTS))).toEqual([[1, 3]]);
    });

    it('closes an enclosed sparse patch in a wall (gapBridge)', () => {
        // 7x7 grid, a solid 3x3 wall block centered at (3,3) with the middle
        // cell missing (a sparse scan patch fully enclosed by wall). Close fills
        // it without bloating the surrounding open floor. (Wall kept off the
        // grid edge so the boundary-preserving erosion doesn't grow it.)
        const BIG = { ...OPTS, minX: 0, maxX: 7, minZ: 0, maxZ: 7, gapBridge: 1 };
        const ring = [];
        for (let cx = 2; cx <= 4; cx++) {
            for (let cz = 2; cz <= 4; cz++) {
                if (cx === 3 && cz === 3) continue; // the missing patch
                ring.push(...colPts(cx + 0.5, cz + 0.5, [0, 1, 2, 3]));
            }
        }
        const grid = buildNavGridFromColumns(centersOf(...ring), IDENTITY, BIG);
        expect(isBlocked(grid, 3, 3)).toBe(true);  // enclosed hole sealed
        expect(isBlocked(grid, 0, 0)).toBe(false); // open floor untouched
    });

    it('dilates blocked cells by the inflate radius', () => {
        const pts = centersOf(...colPts(2.5, 2.5, [0, 1, 2, 3]));
        const grid = buildNavGridFromColumns(pts, IDENTITY, { ...OPTS, inflate: 1 });
        expect(blockedCells(grid).sort()).toEqual(
            [[2, 1], [1, 2], [2, 2], [3, 2], [2, 3]].sort());
    });

    it('carries the floorY anchor onto the grid', () => {
        const grid = buildNavGridFromColumns(new Float32Array(0), IDENTITY, { ...OPTS, floorY: 0.12 });
        expect(grid.floorY).toBeCloseTo(0.12);
    });
});

describe('emptyGrid', () => {
    it('is all-free over the given bounds', () => {
        const grid = emptyGrid({ minX: 0, maxX: 5, minZ: 0, maxZ: 5, cell: 1 });
        expect(blockedCells(grid)).toEqual([]);
        expect(grid.cols).toBe(5);
        expect(grid.rows).toBe(5);
        expect(grid.floorY).toBeNull();
    });

    it('carries an explicit floorY', () => {
        expect(emptyGrid({ minX: 0, maxX: 5, minZ: 0, maxZ: 5, cell: 1, floorY: -0.5 }).floorY)
            .toBeCloseTo(-0.5);
    });
});

describe('grid helpers', () => {
    const grid = makeGrid();

    it('treats out-of-bounds cells as blocked', () => {
        expect(isBlocked(grid, -1, 0)).toBe(true);
        expect(isBlocked(grid, 0, 5)).toBe(true);
        expect(isBlocked(grid, 0, 0)).toBe(false);
    });

    it('honors the overlay set', () => {
        expect(isBlocked(grid, 3, 3, new Set([cellIndex(grid, 3, 3)]))).toBe(true);
        expect(isBlocked(grid, 3, 3, new Set())).toBe(false);
    });

    it('round-trips cellToWorld → worldToCell', () => {
        const { x, z } = cellToWorld(grid, 2, 3);
        expect(worldToCell(grid, x, z)).toEqual({ cx: 2, cz: 3 });
    });
});

describe('computeReachable', () => {
    it('excludes the far side of a sealing wall', () => {
        const grid = makeGrid([[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]]);
        const { mask, list } = computeReachable(grid, 0, 0);
        expect(list).toHaveLength(10); // the two rows on the near side
        expect(mask[cellIndex(grid, 4, 1)]).toBe(1);
        expect(mask[cellIndex(grid, 0, 3)]).toBe(0);
        expect(mask[cellIndex(grid, 2, 2)]).toBe(0); // the wall itself
    });

    it('is empty from a blocked start', () => {
        const grid = makeGrid([[2, 2]]);
        expect(computeReachable(grid, 2, 2).list).toHaveLength(0);
    });
});

describe('nearestFreeCell', () => {
    it('returns the cell itself when free', () => {
        expect(nearestFreeCell(makeGrid(), 2, 2)).toEqual({ cx: 2, cz: 2 });
    });

    it('finds an adjacent free cell from inside an obstacle', () => {
        const grid = makeGrid([[2, 2]]);
        const free = nearestFreeCell(grid, 2, 2);
        expect(free).not.toBeNull();
        expect(isBlocked(grid, free.cx, free.cz)).toBe(false);
        expect(Math.abs(free.cx - 2) + Math.abs(free.cz - 2)).toBe(1);
    });

    it('clamps an out-of-bounds start into the grid', () => {
        expect(nearestFreeCell(makeGrid(), -3, 99)).toEqual({ cx: 0, cz: 4 });
    });
});
