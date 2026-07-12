import { describe, it, expect, beforeEach } from 'vitest';
import {
    applyParams,
    resolveStartup,
    saveSession,
    roomBoundsChanged,
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

    it('round-trips a saved session through saveSession', () => {
        const view = { position: { x: 1, y: 2, z: 3 }, focus: { x: 4, y: 5, z: 6 } };
        saveSession(view, defaultParams);
        const restored = resolveStartup();
        expect(restored.view.position).toEqual({ x: 1, y: 2, z: 3 });
        expect(restored.view.focus).toEqual({ x: 4, y: 5, z: 6 });
    });

    it('fills new default subtrees missing from an older saved session', () => {
        // a session saved before source.demo existed: its source tree lacks
        // the demo subtree, and the new defaults must survive the merge
        localStorage.setItem('garage-viewer-settings', JSON.stringify({
            view: { position: { x: 0, y: 0, z: 0 }, focus: { x: 0, y: 0, z: 0 } },
            params: { source: { mode: 'demo', demoSpeed: 0.5 } }
        }));
        const { params } = resolveStartup();
        expect(params.source.mode).toBe('demo');
        expect(params.source.demoSpeed).toBe(0.5);
        expect(params.source.demo).toEqual(defaultParams.source.demo);
    });

    it('round-trips the room-bounds fingerprint through saveSession', () => {
        const view = { position: { x: 1, y: 2, z: 3 }, focus: { x: 4, y: 5, z: 6 } };
        const roomBounds = { center: { x: 1, y: 2, z: 3 }, halfExtents: { x: 4, y: 5, z: 6 } };
        saveSession(view, defaultParams, roomBounds);
        expect(resolveStartup().roomBounds).toEqual(roomBounds);
    });

    it('has no room-bounds fingerprint for a session saved without one', () => {
        const view = { position: { x: 1, y: 2, z: 3 }, focus: { x: 4, y: 5, z: 6 } };
        saveSession(view, defaultParams);
        expect(resolveStartup().roomBounds).toBeUndefined();
    });
});

describe('roomBoundsChanged', () => {
    const bounds = { center: { x: 0, y: 1, z: 0 }, halfExtents: { x: 2, y: 1, z: 2 } };

    it('is true when there is no saved fingerprint (fresh install, or pre-fingerprint session)', () => {
        expect(roomBoundsChanged(undefined, bounds)).toBe(true);
    });

    it('is false for an identical fingerprint', () => {
        expect(roomBoundsChanged(bounds, bounds)).toBe(false);
    });

    it('is false within tolerance (re-scan noise)', () => {
        const nearlySame = { center: { x: 0.1, y: 1, z: 0 }, halfExtents: { x: 2, y: 1, z: 2.1 } };
        expect(roomBoundsChanged(bounds, nearlySame, 0.25)).toBe(false);
    });

    it('is true when a different room/layout was scanned', () => {
        const different = { center: { x: 5, y: 1, z: 0 }, halfExtents: { x: 2, y: 1, z: 2 } };
        expect(roomBoundsChanged(bounds, different)).toBe(true);
    });
});
