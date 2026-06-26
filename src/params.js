import defaults from './defaults.json';

// Live settings bound to the control panel. Initialized from defaults.json;
// session overrides are applied in main.js before the scene is built.
export const params = structuredClone(defaults.params);
