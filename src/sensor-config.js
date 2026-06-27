// Single source of truth for the mmWave (LD2450) display constants and the
// per-target slot palette, shared by the minimap and the in-scene overlay so
// the two diagnostic views can't drift out of sync.

export const HALF_FOV_DEG = 60;      // LD2450 ~120° horizontal field of view
export const MAX_RANGE_MM = 6000;    // ~6 m usable range
export const MAX_RANGE_M = MAX_RANGE_MM / 1000;
export const SAMPLE_STALE_MS = 1500; // a reading older than this counts as "gone"

// One colour per target slot (matches the up-to-three orbs). Defined once as
// rgb triples; the hex strings are derived so the two encodings can't diverge.
export const SLOT_RGB = [
    [255, 90, 90],   // slot 0
    [255, 177, 74],  // slot 1
    [73, 224, 160]   // slot 2
];

export const SLOT_HEX = SLOT_RGB.map(
    ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
);
