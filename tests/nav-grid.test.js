import { describe, it, expect } from 'vitest';
import {
    buildNavGrid, buildNavGridFromPoints, estimateFloorY,
    cellIndex, isBlocked, worldToCell, cellToWorld,
    computeReachable, nearestFreeCell
} from '../src/nav-grid.js';

/** Pack triangles given as [ax,ay,az, bx,by,bz, cx,cy,cz] rows into a mesh. */
function meshOf(...tris) {
    return { positions: new Float32Array(tris.flat()), indices: null };
}

// 5x5 m footprint, 1 m cells, obstacle band 0.1–2 m
const BOUNDS = { minX: 0, maxX: 5, minZ: 0, maxZ: 5, cell: 1, yMin: 0.1, yMax: 2, inflate: 0 };

function blockedCells(grid) {
    const out = [];
    for (let cz = 0; cz < grid.rows; cz++) {
        for (let cx = 0; cx < grid.cols; cx++) {
            if (grid.blocked[cz * grid.cols + cx]) out.push([cx, cz]);
        }
    }
    return out;
}

describe('buildNavGrid', () => {
    it('marks exactly the cell under a small obstacle-height triangle', () => {
        const mesh = meshOf([2.2, 1, 2.2, 2.8, 1, 2.2, 2.5, 1, 2.8]);
        const grid = buildNavGrid([mesh], BOUNDS);
        expect(blockedCells(grid)).toEqual([[2, 2]]);
    });

    it('ignores floor and ceiling triangles outside the height band', () => {
        const floor = meshOf([0, 0.02, 0, 5, 0.02, 0, 2.5, 0.02, 5]);
        const ceiling = meshOf([0, 2.5, 0, 5, 2.5, 0, 2.5, 2.5, 5]);
        const grid = buildNavGrid([floor, ceiling], BOUNDS);
        expect(blockedCells(grid)).toEqual([]);
    });

    it('blocks a gap-free row under a thin vertical wall', () => {
        // wall quad spanning x 0–5 at z = 2.5 (degenerate in XZ projection)
        const wall = meshOf(
            [0, 0, 2.5, 5, 0, 2.5, 5, 1.8, 2.5],
            [0, 0, 2.5, 5, 1.8, 2.5, 0, 1.8, 2.5]
        );
        const grid = buildNavGrid([wall], BOUNDS);
        expect(blockedCells(grid)).toEqual([[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]]);
    });

    it('does not mark cells inside the triangle AABB that the triangle misses', () => {
        // right triangle with hypotenuse x+z=3: its AABB covers a 4x4 block of
        // cells but the far corner cells lie fully beyond the hypotenuse
        const mesh = meshOf([0, 1, 0, 3, 1, 0, 0, 1, 3]);
        const grid = buildNavGrid([mesh], BOUNDS);
        expect(blockedCells(grid)).toEqual([
            [0, 0], [1, 0], [2, 0], [3, 0],
            [0, 1], [1, 1], [2, 1],
            [0, 2], [1, 2],
            [0, 3]
        ]);
        expect(isBlocked(grid, 2, 2)).toBe(false);
        expect(isBlocked(grid, 3, 1)).toBe(false);
    });

    it('dilates a blocked cell into a euclidean disc', () => {
        const mesh = meshOf([2.4, 1, 2.4, 2.6, 1, 2.4, 2.5, 1, 2.6]);
        const grid = buildNavGrid([mesh], { ...BOUNDS, inflate: 1 });
        // radius 1 cell: center + the four orthogonal neighbors, no diagonals
        expect(blockedCells(grid).sort()).toEqual(
            [[2, 1], [1, 2], [2, 2], [3, 2], [2, 3]].sort());
    });

    it('yields an all-free grid for no geometry', () => {
        const grid = buildNavGrid([], BOUNDS);
        expect(blockedCells(grid)).toEqual([]);
        expect(grid.cols).toBe(5);
        expect(grid.rows).toBe(5);
    });

    it('reads indexed triangle lists', () => {
        const mesh = {
            positions: new Float32Array([2.2, 1, 2.2, 2.8, 1, 2.2, 2.5, 1, 2.8]),
            indices: new Uint32Array([0, 1, 2])
        };
        const grid = buildNavGrid([mesh], BOUNDS);
        expect(blockedCells(grid)).toEqual([[2, 2]]);
    });
});

// column-major 4x4 matrices for the point-based builders
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

describe('buildNavGridFromPoints', () => {
    const OPTS = {
        minX: 0, maxX: 5, minZ: 0, maxZ: 5, cell: 1,
        yMin: 0.1, yMax: 2, inflate: 0, minCount: 4
    };

    it('blocks a cell only at or above minCount', () => {
        const below = centersOf(...cluster(3, 2.5, 1, 2.5));
        expect(blockedCells(buildNavGridFromPoints(below, IDENTITY, OPTS))).toEqual([]);
        const at = centersOf(...cluster(4, 2.5, 1, 2.5));
        expect(blockedCells(buildNavGridFromPoints(at, IDENTITY, OPTS))).toEqual([[2, 2]]);
    });

    it('ignores points outside the height band', () => {
        const pts = centersOf(
            ...cluster(10, 2.5, 0.02, 2.5), // floor fuzz below yMin
            ...cluster(10, 2.5, 2.6, 2.5)   // ceiling above yMax
        );
        expect(blockedCells(buildNavGridFromPoints(pts, IDENTITY, OPTS))).toEqual([]);
    });

    it('transforms points through the matrix before binning', () => {
        // local (1.5, -1, -3.5) → world (1.5, 1, 3.5) under the X flip
        const pts = centersOf(...cluster(4, 1.5, -1, -3.5));
        expect(blockedCells(buildNavGridFromPoints(pts, FLIP_X180, OPTS))).toEqual([[1, 3]]);
    });

    it('dilates blocked cells by the inflate radius', () => {
        const pts = centersOf(...cluster(4, 2.5, 1, 2.5));
        const grid = buildNavGridFromPoints(pts, IDENTITY, { ...OPTS, inflate: 1 });
        expect(blockedCells(grid).sort()).toEqual(
            [[2, 1], [1, 2], [2, 2], [3, 2], [2, 3]].sort());
    });

    it('carries the floorY anchor onto the grid (both builders)', () => {
        const fromPoints = buildNavGridFromPoints(new Float32Array(0), IDENTITY, { ...OPTS, floorY: 0.12 });
        expect(fromPoints.floorY).toBeCloseTo(0.12);
        const fromMesh = buildNavGrid([], { ...BOUNDS, floorY: -0.5 });
        expect(fromMesh.floorY).toBeCloseTo(-0.5);
        expect(buildNavGrid([], BOUNDS).floorY).toBeNull();
    });
});

describe('grid helpers', () => {
    const grid = buildNavGrid([], BOUNDS);

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
        const wall = meshOf(
            [0, 0, 2.5, 5, 0, 2.5, 5, 1.8, 2.5],
            [0, 0, 2.5, 5, 1.8, 2.5, 0, 1.8, 2.5]
        );
        const grid = buildNavGrid([wall], BOUNDS);
        const { mask, list } = computeReachable(grid, 0, 0);
        expect(list).toHaveLength(10); // the two rows on the near side
        expect(mask[cellIndex(grid, 4, 1)]).toBe(1);
        expect(mask[cellIndex(grid, 0, 3)]).toBe(0);
        expect(mask[cellIndex(grid, 2, 2)]).toBe(0); // the wall itself
    });

    it('is empty from a blocked start', () => {
        const wall = meshOf([2.2, 1, 2.2, 2.8, 1, 2.2, 2.5, 1, 2.8]);
        const grid = buildNavGrid([wall], BOUNDS);
        expect(computeReachable(grid, 2, 2).list).toHaveLength(0);
    });
});

describe('nearestFreeCell', () => {
    it('returns the cell itself when free', () => {
        const grid = buildNavGrid([], BOUNDS);
        expect(nearestFreeCell(grid, 2, 2)).toEqual({ cx: 2, cz: 2 });
    });

    it('finds an adjacent free cell from inside an obstacle', () => {
        const wall = meshOf([2.2, 1, 2.2, 2.8, 1, 2.2, 2.5, 1, 2.8]);
        const grid = buildNavGrid([wall], BOUNDS);
        const free = nearestFreeCell(grid, 2, 2);
        expect(free).not.toBeNull();
        expect(isBlocked(grid, free.cx, free.cz)).toBe(false);
        expect(Math.abs(free.cx - 2) + Math.abs(free.cz - 2)).toBe(1);
    });

    it('clamps an out-of-bounds start into the grid', () => {
        const grid = buildNavGrid([], BOUNDS);
        expect(nearestFreeCell(grid, -3, 99)).toEqual({ cx: 0, cz: 4 });
    });
});
