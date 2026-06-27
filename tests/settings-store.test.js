import { describe, it, expect, beforeEach } from 'vitest';
import {
    applyParams,
    resolveStartup,
    saveSession,
    defaultView,
    defaultParams
} from '../src/settings-store.js';

// Minimal in-memory Storage mock — jsdom's localStorage in this environment
// doesn't implement the full Storage API, so we install a clean one per test.
function mockLocalStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };
}

beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        value: mockLocalStorage(),
        configurable: true,
        writable: true
    });
});

describe('applyParams (deep merge)', () => {
    it('merges nested objects in place', () => {
        const target = { a: 1, nested: { x: 1, y: 2 } };
        applyParams(target, { a: 9, nested: { y: 20 } });
        expect(target).toEqual({ a: 9, nested: { x: 1, y: 20 } });
    });

    it('replaces arrays wholesale rather than merging them', () => {
        const target = { arr: [1, 2, 3] };
        applyParams(target, { arr: [7] });
        expect(target.arr).toEqual([7]);
    });
});

describe('resolveStartup', () => {
    it('returns shipped defaults when there is no session', () => {
        const { view, params } = resolveStartup();
        expect(view).toEqual(defaultView);
        expect(params).toEqual(defaultParams);
    });

    it('returns defaults (not a throw) when the stored JSON is corrupt', () => {
        localStorage.setItem('garage-viewer-settings', '{ broken json');
        expect(resolveStartup().view).toEqual(defaultView);
    });

    it('migrates the legacy spawn-only save key', () => {
        localStorage.setItem(
            'garage-viewer-spawn-view',
            JSON.stringify({ position: { x: 1, y: 2, z: 3 }, focus: { x: 0, y: 0, z: 0 } })
        );
        const { view } = resolveStartup();
        expect(view.position).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('round-trips a saved session through saveSession', () => {
        const view = { position: { x: 1, y: 2, z: 3 }, focus: { x: 4, y: 5, z: 6 } };
        saveSession(view, defaultParams);
        const restored = resolveStartup();
        expect(restored.view.position).toEqual({ x: 1, y: 2, z: 3 });
        expect(restored.view.focus).toEqual({ x: 4, y: 5, z: 6 });
    });
});
