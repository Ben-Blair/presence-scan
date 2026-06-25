// Custom gsplat shader hook (gsplatModifyVS chunk). In unified mode this runs
// in the copy-to-workbuffer pass where splat centers are in WORLD space.
//
// Two effects:
//  1. Orb glow: point-light style falloff added to splat color around the orb.
//  2. Cutaway: a view-dependent "see-inside" peel. The room is an axis-aligned
//     box; for each box face the camera is clearly OUTSIDE of, the splats just
//     past that face (the near wall + the floaters/fuzz in front of it) fade out,
//     while the interior, far wall, side walls, and far-side floaters stay solid.
//     Because it peels by face (not a single angled plane) the whole near wall
//     clears even when you view it off-center. When the camera is inside the box
//     no face qualifies, so nothing is culled.

const GLSL = /* glsl */`
uniform vec3 uOrbPos0;       // up to three orb positions (one per tracked person)
uniform vec3 uOrbPos1;
uniform vec3 uOrbPos2;
uniform float uOrbCount;     // how many of the above are active (0..3)
uniform vec3 uOrbColor;
uniform float uOrbIntensity;
uniform float uOrbRadius;
uniform vec3 uViewPos;
uniform float uGlowFacing;

uniform float uCutEnabled;
uniform vec3 uCutCamPos;
uniform vec3 uWallPeelPos;   // peel depth for the +X/+Y/+Z faces
uniform vec3 uWallPeelNeg;   // peel depth for the -X/-Y/-Z faces
uniform float uCutSoft;
uniform float uCutEngage;
uniform vec3 uRoomMin;
uniform vec3 uRoomMax;

// approximate per-splat surface normal + anisotropy, computed in
// modifySplatRotationScale and consumed in modifySplatColor (same shader run)
vec3 gSplatNormal = vec3(0.0);
float gSplatAniso = 0.0;

vec3 quatRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    // normals are only consumed by the orb glow; skip the quat work when off.
    if (uOrbIntensity <= 0.0 || uGlowFacing <= 0.0) return;

    // the gaussian's flattest axis (smallest scale) approximates the surface normal
    vec3 s = scale;
    vec3 axis;
    if (s.x <= s.y && s.x <= s.z) axis = vec3(1.0, 0.0, 0.0);
    else if (s.y <= s.z) axis = vec3(0.0, 1.0, 0.0);
    else axis = vec3(0.0, 0.0, 1.0);
    gSplatNormal = normalize(quatRotate(rotation, axis));

    float minS = min(s.x, min(s.y, s.z));
    float maxS = max(s.x, max(s.y, s.z));
    gSplatAniso = maxS > 0.0 ? clamp((maxS - minS) / maxS, 0.0, 1.0) : 0.0;
}

// point-light style glow contribution from one orb onto this splat.
vec3 orbGlow(vec3 center, vec3 orbPos) {
    float d = distance(center, orbPos);
    float r = max(uOrbRadius, 0.001);
    float atten = 1.0 / (1.0 + (d * d) / (r * r));
    // hard cutoff well outside the radius so distant splats are untouched
    float cutoff = smoothstep(r * 4.0, r, d);

    // only glow surfaces oriented toward the orb. flip the (sign-ambiguous)
    // normal to the visible face, then test against the direction to the orb.
    vec3 n = gSplatNormal;
    if (dot(n, normalize(uViewPos - center)) < 0.0) n = -n;
    float facing = smoothstep(-0.1, 0.4, dot(n, normalize(orbPos - center)));
    // round/isotropic splats have no reliable normal, so fall back to full glow
    facing = mix(1.0, facing, gSplatAniso * uGlowFacing);

    return uOrbColor * (uOrbIntensity * atten * cutoff * facing);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    // accumulate the glow from each active orb (up to three tracked people)
    if (uOrbIntensity > 0.0) {
        if (uOrbCount > 0.5) color.rgb += orbGlow(center, uOrbPos0);
        if (uOrbCount > 1.5) color.rgb += orbGlow(center, uOrbPos1);
        if (uOrbCount > 2.5) color.rgb += orbGlow(center, uOrbPos2);
    }

    // cutaway: peel the camera-facing wall(s) of the room box so you can see in.
    if (uCutEnabled > 0.5) {
        vec3 roomCenter = (uRoomMin + uRoomMax) * 0.5;
        vec3 roomHalf = (uRoomMax - uRoomMin) * 0.5;

        // only peel faces the camera is clearly outside of, and ramp the peel in
        // smoothly over uCutEngage meters as the camera moves out (no hard pop).
        // Below the 0.3m start it is fully off, so standing near a wall from the
        // inside never peels.
        vec3 rel = uCutCamPos - roomCenter;
        vec3 camOutside = smoothstep(0.3, 0.3 + max(uCutEngage, 0.001), abs(rel) - roomHalf);
        vec3 camSign = sign(rel);

        // each face has its own peel depth; pick the +/- side facing the camera.
        // hide splats past the peel plane (the near face pulled inward by peel).
        // take the strongest peel across the up-to-three faces the camera looks
        // through; non-facing faces contribute 0 (multiplied out).
        vec3 peel = mix(uWallPeelNeg, uWallPeelPos, step(0.0, rel));
        vec3 srel = center - roomCenter;
        vec3 beyond = (srel * camSign - (roomHalf - peel)) * camOutside;
        float cut = max(beyond.x, max(beyond.y, beyond.z));
        float fade = 1.0 - smoothstep(0.0, uCutSoft, cut);

        color.a *= fade;
    }
}
`;

const WGSL = /* wgsl */`
uniform uOrbPos0: vec3f;      // up to three orb positions (one per tracked person)
uniform uOrbPos1: vec3f;
uniform uOrbPos2: vec3f;
uniform uOrbCount: f32;       // how many of the above are active (0..3)
uniform uOrbColor: vec3f;
uniform uOrbIntensity: f32;
uniform uOrbRadius: f32;
uniform uViewPos: vec3f;
uniform uGlowFacing: f32;

uniform uCutEnabled: f32;
uniform uCutCamPos: vec3f;
uniform uWallPeelPos: vec3f;   // peel depth for the +X/+Y/+Z faces
uniform uWallPeelNeg: vec3f;   // peel depth for the -X/-Y/-Z faces
uniform uCutSoft: f32;
uniform uCutEngage: f32;
uniform uRoomMin: vec3f;
uniform uRoomMax: vec3f;

// approximate per-splat surface normal + anisotropy, computed in
// modifySplatRotationScale and consumed in modifySplatColor (same shader run)
var<private> gSplatNormal: vec3f = vec3f(0.0);
var<private> gSplatAniso: f32 = 0.0;

fn quatRotate(q: vec4f, v: vec3f) -> vec3f {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    // normals are only consumed by the orb glow; skip the quat work when off.
    if (uniform.uOrbIntensity <= 0.0 || uniform.uGlowFacing <= 0.0) { return; }

    // the gaussian's flattest axis (smallest scale) approximates the surface normal
    let s = (*scale);
    var axis: vec3f;
    if (s.x <= s.y && s.x <= s.z) {
        axis = vec3f(1.0, 0.0, 0.0);
    } else if (s.y <= s.z) {
        axis = vec3f(0.0, 1.0, 0.0);
    } else {
        axis = vec3f(0.0, 0.0, 1.0);
    }
    gSplatNormal = normalize(quatRotate((*rotation), axis));

    let minS = min(s.x, min(s.y, s.z));
    let maxS = max(s.x, max(s.y, s.z));
    gSplatAniso = select(0.0, clamp((maxS - minS) / maxS, 0.0, 1.0), maxS > 0.0);
}

// point-light style glow contribution from one orb onto this splat.
fn orbGlow(center: vec3f, orbPos: vec3f) -> vec3f {
    let d = distance(center, orbPos);
    let r = max(uniform.uOrbRadius, 0.001);
    let atten = 1.0 / (1.0 + (d * d) / (r * r));
    let cutoff = smoothstep(r * 4.0, r, d);

    // only glow surfaces oriented toward the orb. flip the (sign-ambiguous)
    // normal to the visible face, then test against the direction to the orb.
    var n = gSplatNormal;
    if (dot(n, normalize(uniform.uViewPos - center)) < 0.0) {
        n = -n;
    }
    var facing = smoothstep(-0.1, 0.4, dot(n, normalize(orbPos - center)));
    // round/isotropic splats have no reliable normal, so fall back to full glow
    facing = mix(1.0, facing, gSplatAniso * uniform.uGlowFacing);

    return uniform.uOrbColor * (uniform.uOrbIntensity * atten * cutoff * facing);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    // accumulate the glow from each active orb (up to three tracked people)
    if (uniform.uOrbIntensity > 0.0) {
        var glow = vec3f(0.0);
        if (uniform.uOrbCount > 0.5) { glow += orbGlow(center, uniform.uOrbPos0); }
        if (uniform.uOrbCount > 1.5) { glow += orbGlow(center, uniform.uOrbPos1); }
        if (uniform.uOrbCount > 2.5) { glow += orbGlow(center, uniform.uOrbPos2); }
        (*color) = vec4f((*color).rgb + glow, (*color).a);
    }

    if (uniform.uCutEnabled > 0.5) {
        // peel the camera-facing wall(s) of the room box so you can see in.
        let roomCenter = (uniform.uRoomMin + uniform.uRoomMax) * 0.5;
        let roomHalf = (uniform.uRoomMax - uniform.uRoomMin) * 0.5;

        // only peel faces the camera is clearly outside of, and ramp the peel in
        // smoothly over uCutEngage meters as the camera moves out (no hard pop).
        // Below the 0.3m start it is fully off, so standing near a wall from the
        // inside never peels.
        let rel = uniform.uCutCamPos - roomCenter;
        let engageEnd = 0.3 + max(uniform.uCutEngage, 0.001);
        let camOutside = smoothstep(vec3f(0.3), vec3f(engageEnd), abs(rel) - roomHalf);
        let camSign = sign(rel);

        // each face has its own peel depth; pick the +/- side facing the camera.
        // hide splats past the peel plane (the near face pulled inward by peel).
        // take the strongest peel across the up-to-three faces the camera looks
        // through; non-facing faces contribute 0 (multiplied out).
        let peel = mix(uniform.uWallPeelNeg, uniform.uWallPeelPos, step(vec3f(0.0), rel));
        let srel = center - roomCenter;
        let beyond = (srel * camSign - (roomHalf - peel)) * camOutside;
        let cut = max(beyond.x, max(beyond.y, beyond.z));
        let fade = 1.0 - smoothstep(0.0, uniform.uCutSoft, cut);

        (*color) = vec4f((*color).rgb, (*color).a * fade);
    }
}
`;

export class SplatFX {
    constructor(app, splatEntity) {
        this.app = app;
        this.splatEntity = splatEntity;
        this._last = null;
    }

    /** Install the custom chunk on the unified gsplat template material. */
    apply() {
        const material = this.app.scene.gsplat.material;
        material.getShaderChunks('glsl').set('gsplatModifyVS', GLSL);
        material.getShaderChunks('wgsl').set('gsplatModifyVS', WGSL);
        material.update();
    }

    /** One-time room bounds for the dollhouse fade (slightly expanded box). */
    setRoomBounds(min, max) {
        const g = this.splatEntity.gsplat;
        g.setParameter('uRoomMin', [min.x, min.y, min.z]);
        g.setParameter('uRoomMax', [max.x, max.y, max.z]);
    }

    /**
     * Push uniforms from a named-field object. Setting parameters on the gsplat
     * component marks the placement render-dirty (re-copies the workbuffer +
     * resorts), so this short-circuits when nothing changed.
     *
     * @param {object} p
     * @param {number[][]} p.orbs        - active orb positions [[x,y,z], …] (0..3)
     * @param {number[]} p.orbColor      - orb glow color [r,g,b]
     * @param {number}   p.orbIntensity  - glow intensity
     * @param {number}   p.orbRadius     - glow radius
     * @param {number}   p.cutEnabled    - 1/0 cutaway toggle
     * @param {number[]} p.cutCamPos     - cutaway camera position [x,y,z]
     * @param {number[]} p.wallPeelPos   - per-face peel depth for +X/+Y/+Z [x,y,z]
     * @param {number[]} p.wallPeelNeg   - per-face peel depth for -X/-Y/-Z [x,y,z]
     * @param {number}   p.cutSoft       - cutaway fade band
     * @param {number}   p.cutEngage     - distance over which the peel fades in
     * @param {number[]} p.viewPos       - view position for normal-facing test [x,y,z]
     * @param {number}   p.glowFacing    - surface-facing glow weight
     */
    setParams(p) {
        const zero = [0, 0, 0];
        const o0 = p.orbs[0] || zero;
        const o1 = p.orbs[1] || zero;
        const o2 = p.orbs[2] || zero;
        const count = p.orbs.length;
        const key = [
            count, ...o0, ...o1, ...o2, ...p.orbColor, p.orbIntensity, p.orbRadius,
            p.cutEnabled, ...p.cutCamPos, ...p.wallPeelPos, ...p.wallPeelNeg,
            p.cutSoft, p.cutEngage, ...p.viewPos, p.glowFacing
        ].join(',');
        if (key === this._last) return false;
        this._last = key;

        const g = this.splatEntity.gsplat;
        g.setParameter('uOrbCount', count);
        g.setParameter('uOrbPos0', o0);
        g.setParameter('uOrbPos1', o1);
        g.setParameter('uOrbPos2', o2);
        g.setParameter('uOrbColor', p.orbColor);
        g.setParameter('uOrbIntensity', p.orbIntensity);
        g.setParameter('uOrbRadius', p.orbRadius);
        g.setParameter('uCutEnabled', p.cutEnabled);
        g.setParameter('uCutCamPos', p.cutCamPos);
        g.setParameter('uWallPeelPos', p.wallPeelPos);
        g.setParameter('uWallPeelNeg', p.wallPeelNeg);
        g.setParameter('uCutSoft', p.cutSoft);
        g.setParameter('uCutEngage', p.cutEngage);
        g.setParameter('uViewPos', p.viewPos);
        g.setParameter('uGlowFacing', p.glowFacing);
        return true;
    }
}
