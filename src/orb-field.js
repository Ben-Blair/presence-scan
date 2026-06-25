import { Orb } from './orb.js';

const MAX_ORBS = 3; // the LD2450 tracks up to three targets

/**
 * Owns up to three {@link Orb}s — one per tracked person — and is the single
 * object the rest of the app wires to. Single-target subsystems (the follow
 * camera, frame-orb, glow-facing, session save) use {@link primary}; the glow
 * shader, minimap and overlay use {@link active}.
 *
 * Orb i tracks LD2450 slot i: the sensor's target slots are positionally
 * stable, so index == identity keeps each orb easing toward the same person
 * instead of swapping when a second target appears.
 */
export class OrbField {
    constructor(app) {
        this.app = app;
        this.orbs = Array.from({ length: MAX_ORBS }, () => new Orb(app));
        // start as a single visible orb (click/demo modes drive just the primary)
        for (let i = 1; i < MAX_ORBS; i++) this.orbs[i].entity.enabled = false;
        this.activeCount = 1;
    }

    applyParams(orbParams) {
        for (const o of this.orbs) o.applyParams(orbParams);
    }

    /** The primary orb (always orb 0); single-target systems follow this. */
    primary() {
        return this.orbs[0];
    }

    /** The currently-active orbs, in slot order. */
    active() {
        return this.orbs.slice(0, this.activeCount);
    }

    /**
     * Drive the orbs from a list of world-space target positions (Vec3-likes).
     * Orb i eases toward target i; surplus orbs are hidden. A freshly-activated
     * orb is teleported onto its target so it appears in place rather than
     * streaking in from wherever it was parked.
     */
    setTargets(positions) {
        const n = Math.min(positions.length, MAX_ORBS);
        for (let i = 0; i < MAX_ORBS; i++) {
            const o = this.orbs[i];
            if (i < n) {
                if (!o.entity.enabled) {
                    o.teleport(positions[i]);
                    o.entity.enabled = true;
                } else {
                    o.setTarget(positions[i]);
                }
            } else if (o.entity.enabled) {
                o.entity.enabled = false;
            }
        }
        this.activeCount = n;
    }

    /** Collapse to a single visible orb (click/demo modes). Idempotent. */
    collapseToPrimary() {
        if (this.activeCount === 1 && this.orbs[0].entity.enabled) return;
        if (!this.orbs[0].entity.enabled) this.orbs[0].entity.enabled = true;
        for (let i = 1; i < MAX_ORBS; i++) {
            if (this.orbs[i].entity.enabled) this.orbs[i].entity.enabled = false;
        }
        this.activeCount = 1;
    }

    update(dt, smoothing) {
        for (let i = 0; i < this.activeCount; i++) this.orbs[i].update(dt, smoothing);
    }
}
