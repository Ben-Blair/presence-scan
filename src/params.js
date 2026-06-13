import defaults from './defaults.json';

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Live settings bound to the control panel. Initialized from defaults.json;
// session overrides are applied in main.js before the scene is built.
export const params = deepClone(defaults.params);
