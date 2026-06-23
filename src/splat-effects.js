// Custom gsplat shader hook (gsplatModifyVS chunk). In unified mode this runs
// in the copy-to-workbuffer pass where splat centers are in WORLD space.
//
// Two effects:
//  1. Orb glow: point-light style falloff added to splat color around the orb.
//  2. Cutaway: splats between the camera and the focus point (minus a keep
//     distance) fade out, so you can zoom outside the garage and still see in.

const GLSL = /* glsl */`
uniform vec3 uOrbPos;
uniform vec3 uOrbColor;
uniform float uOrbIntensity;
uniform float uOrbRadius;
uniform vec3 uViewPos;
uniform float uGlowFacing;

uniform float uCutEnabled;
uniform vec3 uCutCamPos;
uniform vec3 uCutFocusPos;
uniform float uCutDist;
uniform float uCutSoft;
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

void modifySplatColor(vec3 center, inout vec4 color) {
    // orb glow onto the splat
    if (uOrbIntensity > 0.0) {
        float d = distance(center, uOrbPos);
        float r = max(uOrbRadius, 0.001);
        float atten = 1.0 / (1.0 + (d * d) / (r * r));
        // hard cutoff well outside the radius so distant splats are untouched
        float cutoff = smoothstep(r * 4.0, r, d);

        // only glow surfaces oriented toward the orb. flip the (sign-ambiguous)
        // normal to the visible face, then test against the direction to the orb.
        vec3 n = gSplatNormal;
        if (dot(n, normalize(uViewPos - center)) < 0.0) n = -n;
        float facing = smoothstep(-0.1, 0.4, dot(n, normalize(uOrbPos - center)));
        // round/isotropic splats have no reliable normal, so fall back to full glow
        facing = mix(1.0, facing, gSplatAniso * uGlowFacing);

        color.rgb += uOrbColor * (uOrbIntensity * atten * cutoff * facing);
    }

    // cutaway: hide splats on the camera side of the keep volume, and hide
    // floaters/outliers outside the room box for a clean dollhouse view
    if (uCutEnabled > 0.5) {
        vec3 toFocus = uCutFocusPos - uCutCamPos;
        float focusDist = length(toFocus);
        vec3 dir = toFocus / max(focusDist, 0.0001);
        float t = dot(center - uCutCamPos, dir);
        float cutPlane = focusDist - uCutDist;
        float fade = smoothstep(cutPlane - uCutSoft, cutPlane, t);

        vec3 roomCenter = (uRoomMin + uRoomMax) * 0.5;
        vec3 roomHalf = (uRoomMax - uRoomMin) * 0.5;
        vec3 outsideVec = max(abs(center - roomCenter) - roomHalf, vec3(0.0));
        float outsideDist = length(outsideVec);
        fade *= 1.0 - smoothstep(0.0, 0.6, outsideDist);

        color.a *= fade;
    }
}
`;

const WGSL = /* wgsl */`
uniform uOrbPos: vec3f;
uniform uOrbColor: vec3f;
uniform uOrbIntensity: f32;
uniform uOrbRadius: f32;
uniform uViewPos: vec3f;
uniform uGlowFacing: f32;

uniform uCutEnabled: f32;
uniform uCutCamPos: vec3f;
uniform uCutFocusPos: vec3f;
uniform uCutDist: f32;
uniform uCutSoft: f32;
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

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    if (uniform.uOrbIntensity > 0.0) {
        let d = distance(center, uniform.uOrbPos);
        let r = max(uniform.uOrbRadius, 0.001);
        let atten = 1.0 / (1.0 + (d * d) / (r * r));
        let cutoff = smoothstep(r * 4.0, r, d);

        // only glow surfaces oriented toward the orb. flip the (sign-ambiguous)
        // normal to the visible face, then test against the direction to the orb.
        var n = gSplatNormal;
        if (dot(n, normalize(uniform.uViewPos - center)) < 0.0) {
            n = -n;
        }
        var facing = smoothstep(-0.1, 0.4, dot(n, normalize(uniform.uOrbPos - center)));
        // round/isotropic splats have no reliable normal, so fall back to full glow
        facing = mix(1.0, facing, gSplatAniso * uniform.uGlowFacing);

        (*color) = vec4f((*color).rgb + uniform.uOrbColor * (uniform.uOrbIntensity * atten * cutoff * facing), (*color).a);
    }

    if (uniform.uCutEnabled > 0.5) {
        let toFocus = uniform.uCutFocusPos - uniform.uCutCamPos;
        let focusDist = length(toFocus);
        let dir = toFocus / max(focusDist, 0.0001);
        let t = dot(center - uniform.uCutCamPos, dir);
        let cutPlane = focusDist - uniform.uCutDist;
        var fade = smoothstep(cutPlane - uniform.uCutSoft, cutPlane, t);

        let roomCenter = (uniform.uRoomMin + uniform.uRoomMax) * 0.5;
        let roomHalf = (uniform.uRoomMax - uniform.uRoomMin) * 0.5;
        let outsideVec = max(abs(center - roomCenter) - roomHalf, vec3f(0.0));
        let outsideDist = length(outsideVec);
        fade = fade * (1.0 - smoothstep(0.0, 0.6, outsideDist));

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
     * @param {number[]} p.orbPos        - world-space orb position [x,y,z]
     * @param {number[]} p.orbColor      - orb glow color [r,g,b]
     * @param {number}   p.orbIntensity  - glow intensity
     * @param {number}   p.orbRadius     - glow radius
     * @param {number}   p.cutEnabled    - 1/0 cutaway toggle
     * @param {number[]} p.cutCamPos     - cutaway camera position [x,y,z]
     * @param {number[]} p.cutFocusPos   - cutaway focus position [x,y,z]
     * @param {number}   p.cutDist       - cutaway keep distance
     * @param {number}   p.cutSoft       - cutaway softness
     * @param {number[]} p.viewPos       - view position for normal-facing test [x,y,z]
     * @param {number}   p.glowFacing    - surface-facing glow weight
     */
    setParams(p) {
        const key = [
            ...p.orbPos, ...p.orbColor, p.orbIntensity, p.orbRadius,
            p.cutEnabled, ...p.cutCamPos, ...p.cutFocusPos, p.cutDist, p.cutSoft,
            ...p.viewPos, p.glowFacing
        ].join(',');
        if (key === this._last) return false;
        this._last = key;

        const g = this.splatEntity.gsplat;
        g.setParameter('uOrbPos', p.orbPos);
        g.setParameter('uOrbColor', p.orbColor);
        g.setParameter('uOrbIntensity', p.orbIntensity);
        g.setParameter('uOrbRadius', p.orbRadius);
        g.setParameter('uCutEnabled', p.cutEnabled);
        g.setParameter('uCutCamPos', p.cutCamPos);
        g.setParameter('uCutFocusPos', p.cutFocusPos);
        g.setParameter('uCutDist', p.cutDist);
        g.setParameter('uCutSoft', p.cutSoft);
        g.setParameter('uViewPos', p.viewPos);
        g.setParameter('uGlowFacing', p.glowFacing);
        return true;
    }
}
