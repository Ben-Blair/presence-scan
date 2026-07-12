import defaults from './defaults.json';

const STORAGE_KEY = 'garage-viewer-settings';

/** @typedef {typeof defaults.view} ViewSettings */
/** @typedef {typeof defaults.params} ParamSettings */
/** @typedef {{ view: ViewSettings, params: ParamSettings }} ViewerSettings */
/** @typedef {{x:number, y:number, z:number}} Vec3Like */

function deepAssign(target, source) {
    for (const key of Object.keys(source)) {
        const src = source[key];
        const dst = target[key];
        if (src && typeof src === 'object' && !Array.isArray(src) && dst && typeof dst === 'object') {
            deepAssign(dst, src);
        } else {
            target[key] = src;
        }
    }
}

/** Shipped defaults from defaults.json. */
export const defaultView = defaults.view;
export const defaultParams = structuredClone(defaults.params);

function readSession() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data?.view?.position || !data?.view?.focus) return null;
        return data;
    } catch {
        return null;
    }
}

/** Params + view to use on startup (session override, else defaults.json). */
export function resolveStartup() {
    const session = readSession();
    const params = structuredClone(defaults.params);
    if (session?.params) {
        deepAssign(params, session.params);
    }
    return {
        view: session?.view ?? defaults.view,
        params,
        // undefined for a fresh install or a session saved before this field
        // existed — callers should treat that the same as "definitely stale"
        roomBounds: session?.roomBounds
    };
}

/** Copy resolved startup values into the live params object. */
export function applyParams(target, source) {
    deepAssign(target, source);
}

/**
 * True if `saved` doesn't match `current` closely enough to trust saved
 * spatial data (camera anchors/view/orb position) against the currently
 * loaded scan — including when `saved` is missing entirely (fresh install,
 * or a session saved before room-bounds fingerprinting existed).
 *
 * @param {{center: Vec3Like, halfExtents: Vec3Like} | undefined} saved
 * @param {{center: Vec3Like, halfExtents: Vec3Like}} current
 * @param {number} [tolerance] - meters of per-axis slack (re-scan noise)
 */
export function roomBoundsChanged(saved, current, tolerance = 0.25) {
    if (!saved) return true;
    const axes = ['x', 'y', 'z'];
    for (const axis of axes) {
        if (Math.abs(saved.center[axis] - current.center[axis]) > tolerance) return true;
        if (Math.abs(saved.halfExtents[axis] - current.halfExtents[axis]) > tolerance) return true;
    }
    return false;
}

export function saveSession(view, liveParams, roomBounds) {
    const data = {
        view: {
            position: { x: view.position.x, y: view.position.y, z: view.position.z },
            focus: { x: view.focus.x, y: view.focus.y, z: view.focus.z },
            orb: view.orb
                ? { x: view.orb.x, y: view.orb.y, z: view.orb.z }
                : undefined
        },
        params: structuredClone(liveParams),
        roomBounds: roomBounds
            ? {
                center: { x: roomBounds.center.x, y: roomBounds.center.y, z: roomBounds.center.z },
                halfExtents: { x: roomBounds.halfExtents.x, y: roomBounds.halfExtents.y, z: roomBounds.halfExtents.z }
            }
            : undefined
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return data;
}

export function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
}

/** Restore shipped defaults into live params and return the default view. */
export function resetToDefaults(liveParams) {
    clearSession();
    deepAssign(liveParams, defaultParams);
    return structuredClone(defaultView);
}
