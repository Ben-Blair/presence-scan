/**
 * One Euro Filter (Casiez, Roussel & Vogel, 2012) — an adaptive low-pass
 * filter for noisy position input from human motion. Its cutoff frequency
 * rises with the signal's own estimated speed, so it tracks real movement
 * with little lag while heavily damping jitter when the tracked point is
 * nearly still. Unlike a constant-velocity Kalman filter, it carries no
 * velocity "memory" to overshoot past wherever the signal actually stopped —
 * the filtered value only ever moves toward the raw measurement, never past
 * it, so it can't invent motion the person never made.
 *
 * `minCutoff`/`beta`/`dCutoff` are passed in per-call rather than stored,
 * matching `Orb.update(dt, smoothing)` in `orb.js` — callers re-read the
 * tunable params live rather than caching a copy.
 */
export class OneEuroFilter1D {
    constructor() {
        this._hasValue = false;
        this._x = 0;   // last filtered value
        this._dx = 0;  // last filtered derivative (units/s)
    }

    /**
     * Snap to a fresh measurement with no history (e.g. a slot just appeared).
     *
     * @param {number} value - value to snap to
     */
    reset(value) {
        this._hasValue = true;
        this._x = value;
        this._dx = 0;
    }

    /**
     * @param {number} value - raw measurement
     * @param {number} dt - elapsed seconds since the last sample
     * @param {number} minCutoff - cutoff frequency (Hz) at zero speed; lower = smoother at rest
     * @param {number} beta - how fast the cutoff rises with speed; higher = less lag in motion
     * @param {number} dCutoff - cutoff frequency (Hz) for smoothing the derivative estimate itself
     * @returns {number} the filtered value
     */
    filter(value, dt, minCutoff, beta, dCutoff) {
        if (!this._hasValue) {
            this.reset(value);
            return value;
        }
        const dx = (value - this._x) / dt;
        this._dx += (dx - this._dx) * OneEuroFilter1D._alpha(dCutoff, dt);

        const cutoff = minCutoff + beta * Math.abs(this._dx);
        this._x += (value - this._x) * OneEuroFilter1D._alpha(cutoff, dt);
        return this._x;
    }

    /**
     * @param {number} cutoff - cutoff frequency in Hz
     * @param {number} dt - elapsed seconds since the last sample
     * @returns {number} the low-pass filter's smoothing factor for this cutoff/dt
     */
    static _alpha(cutoff, dt) {
        const tau = 1 / (2 * Math.PI * cutoff);
        return 1 / (1 + tau / dt);
    }
}
