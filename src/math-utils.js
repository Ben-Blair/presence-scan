// Small shared math helpers. Re-exports PlayCanvas's `math` primitives so the
// whole codebase converges on one idiom (instead of some files hand-rolling
// `Math.min(Math.max(...))` / `* Math.PI / 180` and others using pc.math).
import { math } from 'playcanvas';

export const { clamp, lerp, DEG_TO_RAD, RAD_TO_DEG } = math;

/**
 * Frame-rate-independent exponential smoothing factor: the fraction to move
 * from current toward target this frame so the half-life is constant regardless
 * of `dt`. Use as `current += (target - current) * smoothFactor(rate, dt)`.
 *
 * @param {number} rate - higher = snappier (approach speed)
 * @param {number} dt - frame delta in seconds
 * @returns {number} lerp factor in [0, 1]
 */
export function smoothFactor(rate, dt) {
    return 1 - Math.exp(-rate * dt);
}

/**
 * Axis-aligned XZ bounds of a room inset on every side by `margin`.
 *
 * @param {{x:number,z:number}} center
 * @param {{x:number,z:number}} halfExtents
 * @param {number} margin
 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}}
 */
export function insetBoundsXZ(center, halfExtents, margin) {
    return {
        minX: center.x - halfExtents.x + margin,
        maxX: center.x + halfExtents.x - margin,
        minZ: center.z - halfExtents.z + margin,
        maxZ: center.z + halfExtents.z - margin
    };
}

/**
 * Clamp `out.x` / `out.z` into the room bounds inset by `margin`. Mutates and
 * returns `out` (leaves `out.y` untouched).
 *
 * @template {{x:number,z:number}} T
 * @param {T} out
 * @param {{x:number,z:number}} center
 * @param {{x:number,z:number}} halfExtents
 * @param {number} margin
 * @returns {T}
 */
export function clampToRoomXZ(out, center, halfExtents, margin) {
    const b = insetBoundsXZ(center, halfExtents, margin);
    out.x = clamp(out.x, b.minX, b.maxX);
    out.z = clamp(out.z, b.minZ, b.maxZ);
    return out;
}
