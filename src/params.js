import defaults from './defaults.json';

/**
 * @typedef {{
 *   name: string,
 *   box: {minX: number, minZ: number, maxX: number, maxZ: number},
 *   eye: {x: number, y: number, z: number}
 * }} CameraAnchor
 */

/**
 * `camera.anchors` ships empty (see CLAUDE.md) and is always regenerated or
 * restored at runtime, so its element type can't be inferred from the (empty)
 * JSON literal — override it explicitly (an `&` intersection wouldn't do this;
 * it'd intersect `never[]` with `CameraAnchor[]` and stay `never[]`).
 * @typedef {Omit<typeof defaults.params, 'camera'> & {
 *   camera: Omit<typeof defaults.params.camera, 'anchors'> & { anchors: CameraAnchor[] }
 * }} Params
 */

// Live settings bound to the control panel. Initialized from defaults.json;
// session overrides are applied in main.js before the scene is built.
export const params = /** @type {Params} */ (structuredClone(defaults.params));
