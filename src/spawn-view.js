const STORAGE_KEY = 'garage-viewer-spawn-view';

/**
 * @typedef {{ position: { x: number, y: number, z: number }, focus: { x: number, y: number, z: number } }} SpawnView
 */

/** @returns {SpawnView | null} */
export function loadSpawnView() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data?.position || !data?.focus) return null;
        return data;
    } catch {
        return null;
    }
}

/**
 * @param {{ x: number, y: number, z: number }} position
 * @param {{ x: number, y: number, z: number }} focus
 * @returns {SpawnView}
 */
export function saveSpawnView(position, focus) {
    const data = {
        position: { x: position.x, y: position.y, z: position.z },
        focus: { x: focus.x, y: focus.y, z: focus.z }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return data;
}
