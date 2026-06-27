import {
    Entity,
    StandardMaterial,
    Color,
    Vec3
} from 'playcanvas';
import { smoothFactor } from './math-utils.js';

/**
 * The glowing location orb: an emissive core sphere (writes depth, so splats
 * in front of it cover it and it covers splats behind it).
 */
export class Orb {
    constructor(app) {
        this.app = app;
        this.target = new Vec3();
        this._color = new Color(0.25, 0.65, 1.0);

        this.entity = new Entity('orb');

        // emissive core - opaque, writes depth
        this.coreMaterial = new StandardMaterial();
        this.coreMaterial.useLighting = false;
        this.coreMaterial.diffuse = new Color(0, 0, 0);
        this.coreMaterial.emissive = this._color;
        this.coreMaterial.emissiveIntensity = 2;
        this.coreMaterial.update();

        this.core = new Entity('orb-core');
        this.core.addComponent('render', { type: 'sphere' });
        this.core.render?.meshInstances.forEach(mi => (mi.material = this.coreMaterial));
        this.entity.addChild(this.core);

        app.root.addChild(this.entity);
        this.applyParams({
            size: 0.12, coreBrightness: 2,
            color: { r: 0.25, g: 0.65, b: 1.0 }
        });
    }

    /** Snap the orb (and its smoothed target) to a position. */
    teleport(pos) {
        this.target.copy(pos);
        this.entity.setPosition(pos);
    }

    /** Set the smoothed movement target. */
    setTarget(pos) {
        this.target.copy(pos);
    }

    applyParams(orbParams) {
        const { r, g, b } = orbParams.color;
        this._color.set(r, g, b);
        this.coreMaterial.emissive = this._color;
        this.coreMaterial.emissiveIntensity = orbParams.coreBrightness;
        this.coreMaterial.update();

        this.core.setLocalScale(orbParams.size * 2, orbParams.size * 2, orbParams.size * 2);
    }

    /** Per-frame: smooth movement toward the target. */
    update(dt, smoothing) {
        const pos = this.entity.getPosition();
        const t = smoothFactor(smoothing, dt);
        const nx = pos.x + (this.target.x - pos.x) * t;
        const ny = pos.y + (this.target.y - pos.y) * t;
        const nz = pos.z + (this.target.z - pos.z) * t;
        this.entity.setPosition(nx, ny, nz);
    }

    getPosition() {
        return this.entity.getPosition();
    }
}
