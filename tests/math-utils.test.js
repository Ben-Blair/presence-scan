import { describe, it, expect } from 'vitest';
import { smoothFactor, insetBoundsXZ, clampToRoomXZ, clamp } from '../src/math-utils.js';

describe('smoothFactor', () => {
    it('is 0 when no time has passed', () => {
        expect(smoothFactor(5, 0)).toBe(0);
    });

    it('stays within [0, 1) for positive rate/dt', () => {
        const f = smoothFactor(5, 0.016);
        expect(f).toBeGreaterThan(0);
        expect(f).toBeLessThan(1);
    });

    it('increases monotonically with dt (longer frame = move further)', () => {
        expect(smoothFactor(5, 0.032)).toBeGreaterThan(smoothFactor(5, 0.016));
    });

    it('approaches 1 for a large rate*dt', () => {
        expect(smoothFactor(100, 1)).toBeCloseTo(1, 5);
    });

    it('is frame-rate independent across substeps (two half-steps ≈ one full step)', () => {
        const rate = 8;
        const full = smoothFactor(rate, 0.1);
        const half = smoothFactor(rate, 0.05);
        // composing two half-step lerps must equal one full-step lerp
        const composed = 1 - (1 - half) * (1 - half);
        expect(composed).toBeCloseTo(full, 12);
    });
});

describe('insetBoundsXZ', () => {
    it('insets every side by the margin', () => {
        const b = insetBoundsXZ({ x: 0, z: 0 }, { x: 5, z: 3 }, 0.5);
        expect(b).toEqual({ minX: -4.5, maxX: 4.5, minZ: -2.5, maxZ: 2.5 });
    });

    it('respects an off-origin center', () => {
        const b = insetBoundsXZ({ x: 10, z: -10 }, { x: 2, z: 2 }, 0);
        expect(b).toEqual({ minX: 8, maxX: 12, minZ: -12, maxZ: -8 });
    });
});

describe('clampToRoomXZ', () => {
    const center = { x: 0, z: 0 };
    const he = { x: 5, z: 5 };

    it('clamps x and z into the inset bounds', () => {
        const out = { x: 100, y: 1.5, z: -100 };
        clampToRoomXZ(out, center, he, 0.5);
        expect(out.x).toBe(4.5);
        expect(out.z).toBe(-4.5);
    });

    it('leaves y untouched and returns the mutated object', () => {
        const out = { x: 0, y: 7, z: 0 };
        expect(clampToRoomXZ(out, center, he, 0.5)).toBe(out);
        expect(out.y).toBe(7);
    });
});

describe('clamp (re-exported from pc.math)', () => {
    it('clamps below, within, and above the range', () => {
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(99, 0, 10)).toBe(10);
    });
});
