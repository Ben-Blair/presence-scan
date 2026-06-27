import { describe, it, expect } from 'vitest';
import { parseTargets } from '../src/orb-sources.js';

describe('parseTargets', () => {
    it('parses the new { targets: [...] } shape', () => {
        const out = parseTargets(JSON.stringify({ targets: [{ x: 1, y: 2, speed: 3 }] }));
        expect(out).toEqual([{ x: 1, y: 2 }]);
    });

    it('parses multiple targets and drops the speed field', () => {
        const out = parseTargets(
            JSON.stringify({ targets: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })
        );
        expect(out).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    });

    it('filters out targets with non-numeric coordinates', () => {
        const out = parseTargets(
            JSON.stringify({ targets: [{ x: 1, y: 2 }, { x: 'nope', y: 4 }, { y: 5 }] })
        );
        expect(out).toEqual([{ x: 1, y: 2 }]);
    });

    it('accepts the legacy single-target { x, y } shape', () => {
        expect(parseTargets(JSON.stringify({ x: 9, y: 8 }))).toEqual([{ x: 9, y: 8 }]);
    });

    it('returns an empty array for an empty target list (clears the orbs)', () => {
        expect(parseTargets(JSON.stringify({ targets: [] }))).toEqual([]);
    });

    it('returns null for malformed JSON (keep the last frame)', () => {
        expect(parseTargets('{ not json')).toBeNull();
    });

    it('returns null for a recognised-JSON-but-unrecognised shape', () => {
        expect(parseTargets(JSON.stringify({ hello: 'world' }))).toBeNull();
    });
});
