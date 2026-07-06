import { describe, it, expect } from 'vitest';
import { OneEuroFilter1D } from '../src/one-euro-filter.js';

const DT = 0.1;
const MIN_CUTOFF = 0.5;
const BETA = 0.007;
const D_CUTOFF = 1.0;

function variance(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
}

describe('OneEuroFilter1D', () => {
    it('converges to a constant measurement', () => {
        const f = new OneEuroFilter1D();
        f.reset(0);
        let p;
        for (let i = 0; i < 50; i++) p = f.filter(100, DT, MIN_CUTOFF, BETA, D_CUTOFF);
        expect(p).toBeCloseTo(100, 0);
    });

    it('reduces variance on noisy oscillation around a fixed point', () => {
        const f = new OneEuroFilter1D();
        const mean = 1000;
        const amplitude = 50;
        f.reset(mean);
        const raw = [];
        const filtered = [];
        for (let i = 0; i < 60; i++) {
            const measurement = mean + amplitude * ((i % 2) * 2 - 1); // alternating +/- amplitude
            raw.push(measurement);
            filtered.push(f.filter(measurement, DT, MIN_CUTOFF, BETA, D_CUTOFF));
        }
        expect(variance(filtered)).toBeLessThan(0.5 * variance(raw));
    });

    it('tracks a fast-moving ramp with little lag (cutoff adapts to speed)', () => {
        const f = new OneEuroFilter1D();
        const vTrue = 1000; // mm/s, brisk walking speed
        f.reset(0);
        let lag;
        for (let i = 1; i <= 50; i++) {
            const trueP = vTrue * i * DT;
            const p = f.filter(trueP, DT, MIN_CUTOFF, BETA, D_CUTOFF);
            lag = trueP - p;
        }
        // steady-state lag should be small relative to the distance travelled
        expect(Math.abs(lag)).toBeLessThan(vTrue * DT * 2);
    });

    it('never overshoots past an abrupt stop (no velocity memory)', () => {
        const f = new OneEuroFilter1D();
        const vTrue = 1000;
        f.reset(0);
        let p = 0;
        // walk for 2 seconds
        for (let i = 1; i <= 20; i++) p = f.filter(vTrue * i * DT, DT, MIN_CUTOFF, BETA, D_CUTOFF);
        const stopPosition = vTrue * 20 * DT;
        // then stand still — the filtered position must approach the stop
        // point from below and never exceed it
        for (let i = 0; i < 20; i++) {
            p = f.filter(stopPosition, DT, MIN_CUTOFF, BETA, D_CUTOFF);
            expect(p).toBeLessThanOrEqual(stopPosition + 1e-9);
        }
        expect(p).toBeCloseTo(stopPosition, 0);
    });

    it('reset snaps immediately with no lag, discarding prior history', () => {
        const f = new OneEuroFilter1D();
        f.reset(0);
        for (let i = 0; i < 20; i++) f.filter(500, DT, MIN_CUTOFF, BETA, D_CUTOFF); // build up state elsewhere

        f.reset(999);

        expect(f._x).toBe(999);
        expect(f._dx).toBe(0);
    });

    it('the very first sample (no reset) passes through unfiltered', () => {
        const f = new OneEuroFilter1D();
        expect(f.filter(42, DT, MIN_CUTOFF, BETA, D_CUTOFF)).toBe(42);
    });
});
