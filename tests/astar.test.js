import { describe, it, expect } from 'vitest';
import { findPath, hasLineOfSight, smoothPath } from '../src/astar.js';
import { cellIndex, isBlocked } from '../src/nav-grid.js';

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

const at = (cx, cz) => ({ cx, cz });

describe('findPath', () => {
    it('finds the straight line on an empty grid', () => {
        const grid = gridFrom(['.....', '.....', '.....']);
        const path = findPath(grid, at(0, 1), at(4, 1));
        expect(path).not.toBeNull();
        expect(path[0]).toEqual(at(0, 1));
        expect(path[path.length - 1]).toEqual(at(4, 1));
        expect(path).toHaveLength(5); // optimal: 4 orthogonal steps
    });

    it('finds the pure diagonal on an empty grid', () => {
        const grid = gridFrom(['.....', '.....', '.....', '.....', '.....']);
        const path = findPath(grid, at(0, 0), at(4, 4));
        expect(path).toHaveLength(5); // optimal: 4 diagonal steps
    });

    it('returns the trivial path when start equals goal', () => {
        const grid = gridFrom(['...']);
        expect(findPath(grid, at(1, 0), at(1, 0))).toEqual([at(1, 0)]);
    });

    it('detours through a gap in a wall', () => {
        const grid = gridFrom([
            '.....',
            '####.',
            '.....'
        ]);
        const path = findPath(grid, at(0, 0), at(0, 2));
        expect(path).not.toBeNull();
        // must pass through the gap column and never stand on a wall cell
        expect(path.some((c) => c.cx === 4 && c.cz === 1)).toBe(true);
        expect(path.every((c) => !isBlocked(grid, c.cx, c.cz))).toBe(true);
    });

    it('returns null when the goal is sealed off', () => {
        const grid = gridFrom([
            '.....',
            '#####',
            '.....'
        ]);
        expect(findPath(grid, at(0, 0), at(0, 2))).toBeNull();
    });

    it('returns null for a blocked goal', () => {
        const grid = gridFrom(['..#']);
        expect(findPath(grid, at(0, 0), at(2, 0))).toBeNull();
    });

    it('refuses to cut a corner between two touching blocked cells', () => {
        const grid = gridFrom([
            '.#',
            '#.'
        ]);
        expect(findPath(grid, at(0, 0), at(1, 1))).toBeNull();
    });

    it('goes around a corner instead of clipping it', () => {
        const grid = gridFrom([
            '..',
            '#.'
        ]);
        // diagonal (0,0)→(1,1) is legal here only because both flanks are
        // checked: (1,0) is free but (0,1) is blocked → must route via (1,0)
        const path = findPath(grid, at(0, 0), at(1, 1));
        expect(path).toEqual([at(0, 0), at(1, 0), at(1, 1)]);
    });

    it('treats overlay cells as blocked', () => {
        const grid = gridFrom(['.....', '.....', '.....']);
        const overlay = new Set([cellIndex(grid, 2, 1)]);
        const path = findPath(grid, at(0, 1), at(4, 1), overlay);
        expect(path).not.toBeNull();
        expect(path.some((c) => c.cx === 2 && c.cz === 1)).toBe(false);
    });

    it('plans out of a blocked start cell', () => {
        const grid = gridFrom(['#..']);
        const path = findPath(grid, at(0, 0), at(2, 0));
        expect(path).toEqual([at(0, 0), at(1, 0), at(2, 0)]);
    });
});

describe('hasLineOfSight', () => {
    it('is clear across an empty grid', () => {
        const grid = gridFrom(['.....', '.....', '.....']);
        expect(hasLineOfSight(grid, at(0, 0), at(4, 2))).toBe(true);
    });

    it('is blocked by a wall cell on the segment', () => {
        const grid = gridFrom(['..#..']);
        expect(hasLineOfSight(grid, at(0, 0), at(4, 0))).toBe(false);
    });

    it('rejects an exact corner crossing between blocked flanks', () => {
        const grid = gridFrom([
            '.#',
            '#.'
        ]);
        expect(hasLineOfSight(grid, at(0, 0), at(1, 1))).toBe(false);
    });

    it('rejects a corner graze with one blocked flank', () => {
        const grid = gridFrom([
            '..',
            '#.'
        ]);
        expect(hasLineOfSight(grid, at(0, 0), at(1, 1))).toBe(false);
    });

    it('accepts a diagonal with both flanks free', () => {
        const grid = gridFrom([
            '..',
            '..'
        ]);
        expect(hasLineOfSight(grid, at(0, 0), at(1, 1))).toBe(true);
    });
});

describe('smoothPath', () => {
    it('collapses a staircase to its endpoints on an empty grid', () => {
        const grid = gridFrom(['.....', '.....', '.....']);
        const path = findPath(grid, at(0, 0), at(4, 2));
        const smooth = smoothPath(grid, path);
        expect(smooth).toEqual([at(0, 0), at(4, 2)]);
    });

    it('keeps a corner waypoint and every segment stays in line of sight', () => {
        const grid = gridFrom([
            '...',
            '.#.',
            '...'
        ]);
        const path = findPath(grid, at(0, 2), at(2, 0));
        const smooth = smoothPath(grid, path);
        expect(smooth.length).toBeGreaterThanOrEqual(3);
        expect(smooth[0]).toEqual(at(0, 2));
        expect(smooth[smooth.length - 1]).toEqual(at(2, 0));
        for (let i = 0; i < smooth.length - 1; i++) {
            expect(hasLineOfSight(grid, smooth[i], smooth[i + 1])).toBe(true);
        }
    });

    it('passes short paths through untouched', () => {
        const grid = gridFrom(['..']);
        expect(smoothPath(grid, [at(0, 0), at(1, 0)])).toEqual([at(0, 0), at(1, 0)]);
    });
});
