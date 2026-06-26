import defaults from './defaults.json';

const STORAGE_KEY = 'garage-viewer-settings';

/** @typedef {typeof defaults.view} ViewSettings */
/** @typedef {typeof defaults.params} ParamSettings */
/** @typedef {{ view: ViewSettings, params: ParamSettings }} ViewerSettings */

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
        let raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            // migrate legacy spawn-only saves
            raw = localStorage.getItem('garage-viewer-spawn-view');
            if (!raw) return null;
            const legacy = JSON.parse(raw);
            if (!legacy?.position || !legacy?.focus) return null;
            return { view: legacy, params: null };
        }
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
        params
    };
}

/** Copy resolved startup values into the live params object. */
export function applyParams(target, source) {
    deepAssign(target, source);
}

export function saveSession(view, liveParams) {
    const data = {
        view: {
            position: { x: view.position.x, y: view.position.y, z: view.position.z },
            focus: { x: view.focus.x, y: view.focus.y, z: view.focus.z },
            orb: view.orb
                ? { x: view.orb.x, y: view.orb.y, z: view.orb.z }
                : undefined
        },
        params: structuredClone(liveParams)
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
