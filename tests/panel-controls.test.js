import { describe, it, expect } from 'vitest';
import { floatRgbToHex, hexToFloatRgb } from '../src/panel-controls.js';

describe('floatRgbToHex', () => {
    it('converts normalized rgb to a 6-digit hex string', () => {
        expect(floatRgbToHex({ r: 1, g: 0, b: 0 })).toBe('#ff0000');
        expect(floatRgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    });

    it('clamps out-of-range channels into [0, 1]', () => {
        expect(floatRgbToHex({ r: 2, g: -1, b: 0.5 })).toBe('#ff0080');
    });
});

describe('hexToFloatRgb', () => {
    it('parses a hex string into normalized rgb', () => {
        expect(hexToFloatRgb('#ff0000')).toEqual({ r: 1, g: 0, b: 0 });
    });

    it('tolerates a missing leading # and surrounding whitespace', () => {
        expect(hexToFloatRgb('  00ff00 ')).toEqual({ r: 0, g: 1, b: 0 });
    });

    it('falls back to black for an invalid string', () => {
        expect(hexToFloatRgb('not-a-color')).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('round-trips with floatRgbToHex', () => {
        const hex = '#8fd0ff';
        expect(floatRgbToHex(hexToFloatRgb(hex))).toBe(hex);
    });
});
