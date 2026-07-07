import {
    BoundingBox,
    Color,
    Vec3,
    ANIM_PARAMETER_BOOLEAN,
    ANIM_EQUAL_TO
} from 'playcanvas';
import { smoothFactor } from './math-utils.js';

const MAX_CHARACTERS = 3; // mirrors OrbField's MAX_ORBS (LD2450 tracks three)

// speed (m/s) below which the avatar is considered stopped -> plays idle
const MOVE_THRESHOLD = 0.06;
// world speed at which the walk clip plays at its authored cadence (rate 1).
// Above this the playback rate scales up so the feet don't skate; below it,
// it slows down. Roughly a natural human walk.
const NOMINAL_WALK = 1.2;

/**
 * Pull the {@link AnimTrack} out of a loaded glb container's animation list.
 * The container exposes `.animations` as an array of Assets whose `.resource`
 * is the track; be tolerant in case an entry is already a track.
 * @param {any} containerResource
 * @returns {any}
 */
function firstAnimTrack(containerResource) {
    const anims = containerResource?.animations ?? [];
    const entry = anims[0];
    return entry?.resource ?? entry ?? null;
}

/**
 * A single walking avatar. Instantiated from the bitmoji glb, driven by an
 * idle<->walk anim graph. It does NOT own any smoothing of its own — it simply
 * follows a world position handed to it each frame (the orb's already-eased
 * position), faces its direction of travel, and scales its walk cadence with
 * the speed it is actually moving at. Feet are planted on the floor plane, not
 * at the orb's floating height.
 */
export class Character {
    /**
     * @param {import('playcanvas').Application} app
     * @param {number} layerId - render layer (the World layer; see CharacterField)
     * @param {any} modelResource - bitmoji container resource
     * @param {any} idleTrack - AnimTrack for the idle clip
     * @param {any} walkTrack - AnimTrack for the walk clip
     * @param {any} characterParams - params.character
     */
    constructor(app, layerId, modelResource, idleTrack, walkTrack, characterParams) {
        this.app = app;

        this.entity = modelResource.instantiateRenderEntity();
        this.entity.name = 'character';
        app.root.addChild(this.entity);

        // When enabled, the avatar renders opaque on the World layer (like the
        // orb): it writes depth in the opaque pass, and the transparent gsplat
        // depth-tests against that — so foreground splats cover the avatar and the
        // avatar covers splats behind it (two-way, orb-style occlusion). But a
        // skinned mesh sitting in the World layer makes the gsplat compile a black
        // shader variant, so while hidden we detach the render from every layer
        // (render.layers = []) — that keeps orb-only mode and startup clean.
        // setEnabled() re-attaches on show; main.js recompiles the gsplat then.
        // instantiateRenderEntity defaults the render onto the World layer;
        // detach it now (start hidden) and let setEnabled() attach on show.
        this._layerId = layerId;
        this._attached = true;
        this._setAttached(false);

        // Light the avatar evenly so no face ever goes dim as the camera orbits.
        // Directional/ambient lighting can't do this — a face pointing away from
        // the lights always falls off, and the only truly-even source (scene
        // ambient) blacks the gsplat out. Instead we render the avatar *unlit*:
        // move its albedo into the emissive channel and disable lighting, so the
        // texture shows at full brightness on every face regardless of angle.
        // Emissive is per-material and needs no scene lights, so it never touches
        // the splat.
        this._makeUnlit();

        // measure the model's natural height (at scale 1) so we can fit it to a
        // real-world standing height regardless of the glb's authored units.
        this._modelHeight = this._measureHeight() || 1;

        const anim = /** @type {any} */ (this.entity.addComponent('anim', { activate: true }));
        anim.loadStateGraph({
            layers: [{
                name: 'Base',
                states: [
                    { name: 'START' },
                    { name: 'Idle', speed: 1, loop: true },
                    { name: 'Walk', speed: 1, loop: true }
                ],
                transitions: [
                    { from: 'START', to: 'Idle' },
                    {
                        from: 'Idle', to: 'Walk', time: 0.2,
                        conditions: [{ parameterName: 'moving', predicate: ANIM_EQUAL_TO, value: true }]
                    },
                    {
                        from: 'Walk', to: 'Idle', time: 0.2,
                        conditions: [{ parameterName: 'moving', predicate: ANIM_EQUAL_TO, value: false }]
                    }
                ]
            }],
            parameters: {
                moving: { type: ANIM_PARAMETER_BOOLEAN, value: false }
            }
        });
        if (idleTrack) anim.assignAnimation('Idle', idleTrack);
        if (walkTrack) anim.assignAnimation('Walk', walkTrack);
        this._anim = anim;

        this._yaw = 0;          // current facing (deg, about Y)
        this._prev = new Vec3(); // previous frame position (for speed/heading)
        this._needsSnap = true;  // teleport (don't streak) on first update after enabling

        this.entity.enabled = false;
        this.applyParams(characterParams);
    }

    /**
     * Render every mesh instance unlit at full albedo brightness, so no face
     * dims as the camera orbits. Copies each StandardMaterial's diffuse (map,
     * vertex colours and tint) into its emissive channel and turns lighting off.
     */
    _makeUnlit() {
        this.entity.findComponents('render').forEach((/** @type {any} */ render) => {
            render.meshInstances.forEach((/** @type {any} */ mi) => {
                const m = /** @type {any} */ (mi.material);
                if (!m || !('useLighting' in m)) return;
                m.emissiveMap = m.diffuseMap;
                m.emissiveVertexColor = m.diffuseVertexColor;
                m.emissive = new Color(m.diffuse.r, m.diffuse.g, m.diffuse.b);
                m.useLighting = false;
                m.update();
            });
        });
    }

    /** Combined world-AABB height of the model's mesh instances at scale 1. */
    _measureHeight() {
        const aabb = new BoundingBox();
        let init = false;
        this.entity.findComponents('render').forEach((/** @type {any} */ render) => {
            render.meshInstances.forEach((/** @type {any} */ mi) => {
                if (!init) { aabb.copy(mi.aabb); init = true; } else { aabb.add(mi.aabb); }
            });
        });
        return init ? aabb.halfExtents.y * 2 : 0;
    }

    /** @param {any} cp - params.character */
    applyParams(cp) {
        this._heightOffset = cp.heightOffset;
        this._walkSpeedScale = cp.walkSpeedScale;
        this._turnSmoothing = cp.turnSmoothing;
        this._faceOffsetDeg = cp.faceOffsetDeg;
        const s = cp.height / this._modelHeight;
        this.entity.setLocalScale(s, s, s);
    }

    /**
     * Snap to a floor position without any easing/streak (used when the avatar
     * first appears, so it doesn't slide in from a stale spot or spin up).
     * @param {import('playcanvas').Vec3} pos - orb world position (XZ used)
     * @param {number} floorY
     */
    teleport(pos, floorY) {
        this.entity.setPosition(pos.x, floorY + this._heightOffset, pos.z);
        this._prev.set(pos.x, floorY + this._heightOffset, pos.z);
        this._anim.setBoolean('moving', false);
        this._anim.speed = 1;
        this._needsSnap = false;
    }

    /**
     * Follow an orb's world position for one frame: plant feet on the floor at
     * its XZ, face the travel direction, and blend/scale idle<->walk by speed.
     * @param {number} dt
     * @param {import('playcanvas').Vec3} pos - orb world position (XZ used)
     * @param {number} floorY - real floor plane the feet stand on
     */
    update(dt, pos, floorY) {
        if (this._needsSnap) { this.teleport(pos, floorY); return; }

        const y = floorY + this._heightOffset;
        const dx = pos.x - this._prev.x;
        const dz = pos.z - this._prev.z;
        const speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;

        this.entity.setPosition(pos.x, y, pos.z);
        this._prev.set(pos.x, y, pos.z);

        const moving = speed > MOVE_THRESHOLD;
        this._anim.setBoolean('moving', moving);
        this._anim.speed = moving
            ? Math.max(0.4, Math.min(2.5, (speed / NOMINAL_WALK) * this._walkSpeedScale))
            : 1;

        // face the direction of travel (only while actually moving, so a stop
        // doesn't snap the heading to an arbitrary angle)
        if (moving) {
            const targetYaw = Math.atan2(dx, dz) * (180 / Math.PI) + this._faceOffsetDeg;
            let delta = targetYaw - this._yaw;
            delta = ((delta + 180) % 360 + 360) % 360 - 180; // wrap to [-180,180]
            this._yaw += delta * smoothFactor(this._turnSmoothing, dt);
            this.entity.setLocalEulerAngles(0, this._yaw, 0);
        }
    }

    /** Show/hide the avatar. Enabling from hidden snaps it into place next frame. */
    setEnabled(v) {
        if (v && !this.entity.enabled) this._needsSnap = true;
        this.entity.enabled = v;
        this._setAttached(v);
    }

    /**
     * Attach the render to the World layer (visible) or detach it from every
     * layer (hidden). Detaching while hidden keeps the skinned mesh out of the
     * gsplat's shader-variant context, so orb-only mode and startup render clean.
     * @param {boolean} v
     */
    _setAttached(v) {
        if (v === this._attached) return;
        this._attached = v;
        const layers = v ? [this._layerId] : [];
        this.entity.findComponents('render').forEach((/** @type {any} */ r) => {
            r.layers = layers;
        });
    }

    destroy() {
        this.entity.destroy();
    }
}

/**
 * Owns up to three {@link Character}s, one per orb slot, and mirrors
 * {@link OrbField}'s active set each frame. It is the single object main.js
 * wires to for the character representation.
 */
export class CharacterField {
    /**
     * @param {import('playcanvas').Application} app
     * @param {any} modelResource
     * @param {any} idleResource - loaded idle glb container resource
     * @param {any} walkResource - loaded walk glb container resource
     * @param {any} characterParams - params.character
     */
    constructor(app, modelResource, idleResource, walkResource, characterParams) {
        this.params = characterParams;

        // Render the avatars on the World layer, opaque, exactly like the orb: an
        // opaque mesh in the opaque pass writes depth, and the transparent gsplat
        // depth-tests against it. So splats in front of the avatar cover it and
        // the avatar covers splats behind it — two-way occlusion, for free. (The
        // avatar renders unlit — albedo baked into emissive, see
        // Character._makeUnlit — so it needs no scene light rig; a scene light is
        // what would black the gsplat out.) The first render of the skinned mesh
        // still trips a black gsplat variant; main.js recompiles the gsplat
        // material on the character's enable transition to fix it.
        const layer = app.scene.layers.getLayerByName('World');
        if (!layer) throw new Error('CharacterField: World layer not found');
        this.layer = layer;

        const idleTrack = firstAnimTrack(idleResource);
        const walkTrack = firstAnimTrack(walkResource);
        this.characters = Array.from({ length: MAX_CHARACTERS },
            () => new Character(app, layer.id, modelResource, idleTrack, walkTrack, characterParams));
    }

    /** @param {any} cp - params.character */
    applyParams(cp) {
        this.params = cp;
        for (const c of this.characters) c.applyParams(cp);
    }

    /** Hide every avatar (orb mode). */
    hideAll() {
        for (const c of this.characters) c.setEnabled(false);
    }

    /** True if any avatar is currently attached to a render layer (visible). */
    anyAttached() {
        return this.characters.some(c => c._attached);
    }

    /**
     * Mirror the orb field's active set for one frame. Character i follows orb i
     * whenever that orb is active; surplus characters are hidden. Newly-active
     * avatars snap into place (no streak). Feet stand on `floorY`.
     * @param {number} dt
     * @param {import('./orb-field.js').OrbField} field
     * @param {number} floorY
     */
    update(dt, field, floorY) {
        for (let i = 0; i < MAX_CHARACTERS; i++) {
            const orb = field.orbs[i];
            const active = orb.entity.enabled && i < field.activeCount;
            const c = this.characters[i];
            c.setEnabled(active);
            if (active) c.update(dt, orb.getPosition(), floorY);
        }
    }
}
