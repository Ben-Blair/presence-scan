import { describe, it, expect } from 'vitest';
import { estimateRoomBounds } from '../src/room-bounds.js';

// column-major 4x4 matrices for the point-based estimator
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// the splat entity's 180° X rotation: world y = -local y, world z = -local z
const FLIP_X180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** Pack [x,y,z] triples into a Float32Array of centers. */
function centersOf(...pts) {
    return new Float32Array(pts.flat());
}

/** n copies of point [x,y,z] jittered within +-jitter on each axis. */
function cluster(n, x, y, z, jitter = 0.05) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const s = ((i % 5) - 2) / 2; // deterministic -1..1 spread
        out.push([x + s * jitter, y + s * jitter, z + s * jitter]);
    }
    return out;
}

describe('estimateRoomBounds', () => {
    it('hugs the dense room cluster and ignores sparse far-flung floaters', () => {
        const pts = [
            ...cluster(4000, 0, 1, 0, 1.5),  // the room: roughly a 3m box centered at origin
            ...cluster(2, 40, 30, -25)       // a couple of stray floater points, far away
        ];
        const bounds = estimateRoomBounds(centersOf(...pts), IDENTITY);
        expect(bounds.min.x).toBeGreaterThan(-2.5);
        expect(bounds.max.x).toBeLessThan(2.5);
        expect(bounds.min.y).toBeGreaterThan(-1.5);
        expect(bounds.max.y).toBeLessThan(3.5);
        expect(bounds.min.z).toBeGreaterThan(-2.5);
        expect(bounds.max.z).toBeLessThan(2.5);
    });

    it('applies the local->world matrix (splat flip)', () => {
        // local (2,-1,-1.5) -> world (2, 1, 1.5) under the 180° X flip
        // (x passes through, y and z negate)
        const pts = cluster(300, 2, -1, -1.5, 0.01);
        const bounds = estimateRoomBounds(centersOf(...pts), FLIP_X180);
        expect(bounds.min.x).toBeCloseTo(2, 1);
        expect(bounds.max.x).toBeCloseTo(2, 1);
        expect(bounds.min.y).toBeCloseTo(1, 1);
        expect(bounds.max.y).toBeCloseTo(1, 1);
        expect(bounds.min.z).toBeCloseTo(1.5, 1);
        expect(bounds.max.z).toBeCloseTo(1.5, 1);
    });

    it('returns null for empty input', () => {
        expect(estimateRoomBounds(new Float32Array(0), IDENTITY)).toBeNull();
    });
});
