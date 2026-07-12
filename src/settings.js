import './panel.css';
import { createPanel } from './panel-controls.js';

/**
 * Callbacks main.js wires into the panel. Declared here so the panel and main.js
 * can't silently drift out of sync (checkJs validates the object main.js passes).
 *
 * @typedef {Object} PanelHooks
 * @property {import('./orb-sources.js').OrbSources} sources - for the status readout
 * @property {(i: number) => void} captureAnchor
 * @property {() => void} onOrbChanged
 * @property {() => void} onRepresentationChanged
 * @property {() => void} onCharacterChanged
 * @property {() => void} onCameraChanged
 * @property {() => void} onSourceModeChanged
 * @property {() => void} onNavChanged
 * @property {() => void} connectSensor
 * @property {() => void} disconnectSensor
 * @property {() => void} frameOrb
 * @property {() => void} saveSession
 * @property {() => void} resetToDefaults
 */

/**
 * Builds the custom settings panel bound to the shared params object.
 *
 * The panel is an iOS-style page stack: a root page with the primary mode
 * selector and a few essentials, and drill-in sub-pages (Orb / Camera / See
 * inside / Advanced) reached via disclosure rows. All fine-tuning lives under
 * Advanced so the root stays uncluttered.
 *
 * @param {*} params - the shared params object
 * @param {PanelHooks} hooks - callbacks into main.js
 * @returns {{ element: HTMLElement, refresh: () => void, toggle: () => void }}
 */
export function createSettingsPanel(params, hooks) {
    let hidden = false;

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'cp-fab';
    fab.title = 'Show controls (P)';
    fab.textContent = '⚙'; // gear

    function toggle() {
        hidden = !hidden;
        panel.element.classList.toggle('cp--hidden', hidden);
        fab.classList.toggle('cp-fab--show', hidden);
        if (hidden) {
            panel.showRoot(); // reopen clean at the root page
        } else {
            // The page-stack sizes itself off scrollHeight/getBoundingClientRect, which
            // read as 0 while `.cp` sits behind `display: none`. Any resize fired during
            // that window (e.g. toggling display mode, see createDisplayToggle) bakes in
            // a 0px height that a plain class removal here doesn't fix. Re-measure now
            // that the panel is actually visible — same trick buildSection() uses.
            window.dispatchEvent(new Event('resize'));
        }
    }

    const panel = createPanel({ title: 'Presence Scan', onHide: toggle });

    const onOrb = () => hooks.onOrbChanged();
    const onChar = () => hooks.onCharacterChanged();
    const onCam = () => hooks.onCameraChanged();
    const onNav = () => hooks.onNavChanged();

    // ---- sub-pages (built first so root drill rows can target them) ---------

    // --- Orb ---
    const orb = panel.addPage({ id: 'orb', title: 'Orb' });
    orb.addColor(params.orb, 'color', { label: 'color', onChange: onOrb });
    orb.addSlider(params.orb, 'size', { min: 0.02, max: 0.5, step: 0.01, onChange: onOrb });
    orb.addSlider(params.orb, 'coreBrightness', { min: 0, max: 8, step: 0.1, label: 'brightness', onChange: onOrb });
    orb.addSlider(params.orb, 'glowIntensity', { min: 0, max: 6, step: 0.05, label: 'splat glow', onChange: onOrb });
    orb.addSlider(params.orb, 'glowRadius', { min: 0.1, max: 6, step: 0.05, label: 'glow radius', onChange: onOrb });
    orb.addSlider(params.orb, 'glowFacing', { min: 0, max: 1, step: 0.05, label: 'glow facing', onChange: onOrb });
    orb.addSlider(params.orb, 'height', { min: 0, max: 3, step: 0.05, label: 'height (m)', onChange: onOrb });
    orb.addSlider(params.orb, 'smoothing', { min: 0.5, max: 20, step: 0.5, onChange: onOrb });

    // --- Character (walking-avatar representation) ---
    const character = panel.addPage({ id: 'character', title: 'Character' });
    character.addSlider(params.character, 'height', { min: 0.5, max: 3, step: 0.05, label: 'height (m)', onChange: onChar });
    character.addSlider(params.character, 'heightOffset', { min: -1, max: 1, step: 0.02, label: 'floor offset (m)', onChange: onChar });
    character.addSlider(params.character, 'walkSpeedScale', { min: 0.2, max: 3, step: 0.05, label: 'walk speed', onChange: onChar });
    character.addSlider(params.character, 'turnSmoothing', { min: 1, max: 20, step: 0.5, label: 'turn speed', onChange: onChar });
    character.addSlider(params.character, 'faceOffsetDeg', { min: -180, max: 180, step: 5, label: 'facing offset (°)', onChange: onChar });

    // --- Camera (incl. Auto Follow) ---
    const cam = panel.addPage({ id: 'camera', title: 'Camera' });
    cam.addSlider(params.camera, 'fov', { min: 20, max: 120, step: 1, label: 'FOV', onChange: onCam });
    cam.addToggle(params.camera, 'orbitOrb', { label: 'Auto Follow (O)', onChange: onCam });

    // Auto Follow tuning — the auto camera that rides the anchor rail loop.
    const follow = cam.addSection({ title: 'Auto Follow tuning', expanded: false });
    follow.addSlider(params.camera.waypoint, 'railSmoothing', { min: 0.5, max: 8, step: 0.1, label: 'rail follow speed', onChange: onCam });
    follow.addSlider(params.camera.waypoint, 'parkBias', { min: 0, max: 1, step: 0.05, label: 'stick at corners', onChange: onCam });
    follow.addSlider(params.camera.waypoint, 'lookSmoothing', { min: 0.5, max: 12, step: 0.5, label: 'aim speed', onChange: onCam });
    follow.addSlider(params.camera.waypoint, 'heightOffset', { min: -2, max: 2, step: 0.05, label: 'viewing height offset (m)', onChange: onCam });
    follow.addSlider(params.camera.waypoint, 'deadzoneFrac', { min: 0.05, max: 1, step: 0.05, label: 'center deadzone', onChange: onCam });
    follow.addSlider(params.camera.waypoint, 'minOrbDistance', { min: 0.3, max: 3, step: 0.1, label: 'min orb distance (m)', onChange: onCam });

    cam.addSlider(params.camera, 'moveSpeed', { min: 0.5, max: 20, step: 0.5, label: 'move speed', onChange: onCam });
    cam.addSlider(params.camera, 'moveFastSpeed', { min: 1, max: 40, step: 0.5, label: 'fast speed', onChange: onCam });
    cam.addSlider(params.camera, 'rotateSpeed', { min: 0.05, max: 1, step: 0.05, label: 'look speed', onChange: onCam });
    cam.addButton({ title: 'Frame orb (F)', onClick: () => hooks.frameOrb() });

    // Set each zone's camera position by hand: turn Auto Follow off, fly the
    // camera to a good vantage, then click (or press the zone number key).
    const place = cam.addSection({ title: 'Set camera positions', expanded: false });
    params.camera.anchors.forEach((anchor, i) => {
        place.addButton({ title: `Set "${anchor.name}" here (${i + 1})`, onClick: () => hooks.captureAnchor(i) });
    });

    // --- See inside (cutaway / dollhouse) ---
    const cut = panel.addPage({ id: 'seeinside', title: 'See inside' });
    cut.addSelect(params.cutaway, 'mode', { label: 'mode', options: { Auto: 'auto', On: 'on', Off: 'off' } });
    cut.addSlider(params.cutaway, 'softness', { min: 0.05, max: 4, step: 0.05 });
    cut.addSlider(params.cutaway, 'engage', { min: 0.05, max: 3, step: 0.05, label: 'fade-in (m)' });

    // --- Advanced (fine-tuning behind drill-in sub-pages) ---
    const adv = panel.addPage({ id: 'advanced', title: 'Advanced' });

    // Per-side peel depth. x/z are the four walls, y is ceiling/floor. Adjust a
    // slider and watch which side opens up to learn the mapping for this room.
    const peel = adv.addPage({ id: 'wallpeel', title: 'Wall peel' });
    peel.addSlider(params.cutaway.wallPeels, 'xPos', { min: 0, max: 10, step: 0.1, label: 'wall +X' });
    peel.addSlider(params.cutaway.wallPeels, 'xNeg', { min: 0, max: 10, step: 0.1, label: 'wall -X' });
    peel.addSlider(params.cutaway.wallPeels, 'zPos', { min: 0, max: 10, step: 0.1, label: 'wall +Z' });
    peel.addSlider(params.cutaway.wallPeels, 'zNeg', { min: 0, max: 10, step: 0.1, label: 'wall -Z' });
    peel.addSlider(params.cutaway.wallPeels, 'yPos', { min: 0, max: 10, step: 0.1, label: 'ceiling' });
    peel.addSlider(params.cutaway.wallPeels, 'yNeg', { min: 0, max: 10, step: 0.1, label: 'floor' });

    // Demo-mode A* wander: avoidRadius is read live each frame; the grid
    // geometry sliders rebuild the occupancy grid via the hook.
    const demo = adv.addPage({ id: 'demotuning', title: 'Demo path' });
    demo.addSlider(params.source, 'demoSpeed', { min: 0.05, max: 2, step: 0.05, label: 'demo speed (m/s)' });
    demo.addSlider(params.source.demo, 'avoidRadius', { min: 0.2, max: 2, step: 0.05, label: 'orb avoid radius (m)' });
    demo.addSlider(params.source.demo, 'gridCell', { min: 0.1, max: 0.5, step: 0.05, label: 'grid cell (m)', onChange: onNav });
    demo.addSlider(params.source.demo, 'clearance', { min: 0, max: 0.6, step: 0.05, label: 'obstacle clearance (m)', onChange: onNav });
    demo.addSlider(params.source.demo, 'floorOffset', { min: -0.5, max: 0.5, step: 0.01, label: 'floor offset (m)', onChange: onNav });
    demo.addSlider(params.source.demo, 'reachHeight', { min: 0.1, max: 1.5, step: 0.05, label: 'obstacle height (m)', onChange: onNav });
    demo.addSlider(params.source.demo, 'groundGap', { min: 0, max: 0.6, step: 0.05, label: 'grounded within (m)', onChange: onNav });
    demo.addSlider(params.source.demo, 'gapBridge', { min: 0, max: 0.6, step: 0.05, label: 'seal wall gaps (m)', onChange: onNav });
    demo.addSlider(params.source.demo, 'minPerBin', { min: 1, max: 20, step: 1, label: 'min splats per bin', onChange: onNav });

    // Sensor calibration — origin/rotation/scale map sensor space to world space.
    // (The live nav-grid / sensor overlay reveal is the root "under the hood"
    // toggle; the mount sliders here fine-tune the overlay gizmo placement.)
    const sensor = adv.addPage({ id: 'sensorcal', title: 'Sensor calibration' });
    sensor.addText(params.source.sensor, 'url', { label: 'url' });
    sensor.addSlider(params.source.sensor, 'originX', { min: -20, max: 20, step: 0.05, label: 'originX' });
    sensor.addSlider(params.source.sensor, 'originZ', { min: -20, max: 20, step: 0.05, label: 'originZ' });
    sensor.addSlider(params.source.sensor, 'rotationDeg', { min: -360, max: 360, step: 1, label: 'rotationDeg' });
    sensor.addSlider(params.source.sensor, 'scale', { min: 0.0001, max: 0.01, step: 0.0001, label: 'scale', format: (v) => v.toFixed(4) });
    sensor.addToggle(params.source.sensor, 'flipSensorY', { label: 'mirror Y' });
    sensor.addSlider(params.source.sensor, 'mountHeight', { min: 0, max: 4, step: 0.05, label: 'mount height' });
    sensor.addSlider(params.source.sensor, 'mountTilt', { min: -60, max: 60, step: 1, label: 'mount tilt (° down)' });
    // One Euro Filter smoothing raw radar jitter before it becomes an orb
    // target: cutoff rises with estimated speed, so it tracks real movement
    // with little lag while damping jitter hard when nearly still, with no
    // velocity "memory" to overshoot past where the person actually stopped.
    // Starting guesses — hand-tune live while walking around.
    sensor.addToggle(params.source.sensor, 'filterEnabled', { label: 'smooth (1€ filter)' });
    sensor.addSlider(params.source.sensor, 'filterMinCutoff', { min: 0.05, max: 5, step: 0.05, label: 'min cutoff (Hz)' });
    sensor.addSlider(params.source.sensor, 'filterBeta', { min: 0, max: 0.05, step: 0.001, label: 'beta (speed coeff)' });
    sensor.addButton({ title: 'Connect', onClick: () => hooks.connectSensor() });
    sensor.addButton({ title: 'Disconnect', onClick: () => hooks.disconnectSensor() });
    sensor.addReadout({ label: 'status', get: () => hooks.sources.sensorStatus });

    // Rendering / misc.
    const render = adv.addPage({ id: 'rendering', title: 'Rendering' });
    render.addSlider(params.camera, 'renderScale', { min: 0.5, max: 2, step: 0.25, label: 'render scale', onChange: onCam });
    render.addSlider(params.source, 'keyboardSpeed', { min: 0.5, max: 8, step: 0.5, label: 'arrow-key speed' });
    render.addSlider(params.source, 'floorY', { min: -5, max: 5, step: 0.01, label: 'floor height' });

    adv.addDrill({ label: 'Wall peel', page: peel });
    adv.addDrill({ label: 'Demo path', page: demo });
    adv.addDrill({ label: 'Sensor calibration', page: sensor });
    adv.addDrill({ label: 'Rendering', page: render });

    // ---- root page ---------------------------------------------------------
    const root = panel.addPage({ id: 'root', title: 'Presence Scan', root: true });

    // Primary mode: Demo / Sensor are the two headline modes, plus Manual —
    // double-click to place and arrow keys to drive it (internal id stays 'click').
    root.addSegmented(params.source, 'mode', {
        options: { Demo: 'demo', Sensor: 'sensor', Manual: 'click' },
        onChange: () => { hooks.onSourceModeChanged(); syncModeUI(); }
    });

    // Mode-aware "show under the hood": nav grid in demo, sensor overlay in
    // sensor, hidden in click. Backed by get/set functions since the target
    // param changes with the mode.
    const underHood = root.addToggleFn({
        label: 'Show under the hood',
        get: () => (params.source.mode === 'sensor'
            ? params.source.sensor.showOverlay
            : params.source.demo.showNavDebug),
        set: (v) => {
            if (params.source.mode === 'sensor') params.source.sensor.showOverlay = v;
            else params.source.demo.showNavDebug = v;
        }
    });
    function syncModeUI() {
        const mode = params.source.mode;
        underHood.setVisible(mode !== 'click');
        underHood.setLabel(mode === 'sensor' ? 'Show sensor overlay' : 'Show nav grid');
        // the toggle's target param changes with the mode — re-read so the switch
        // reflects the actual state (e.g. overlay on by default in sensor mode)
        underHood.sync();
    }

    // Universal orb <-> walking-character switch, applied in every source mode.
    // Only the selected representation's settings row is shown (Orb when off,
    // Character when on).
    let syncRepr = () => {};
    root.addToggle(params.character, 'enabled', {
        label: 'Walking character',
        onChange: () => { hooks.onRepresentationChanged(); syncRepr(); }
    });

    const orbDrill = root.addDrill({ label: 'Orb', page: orb });
    const charDrill = root.addDrill({ label: 'Character', page: character });
    syncRepr = () => {
        const ch = !!params.character.enabled;
        orbDrill.setVisible(!ch);
        charDrill.setVisible(ch);
    };
    syncRepr();

    root.addDrill({ label: 'Camera', page: cam });
    root.addDrill({ label: 'See inside', page: cut });
    root.addDrill({ label: 'Advanced', page: adv });

    root.addButtonRow([
        { title: 'Save (H)', onClick: () => hooks.saveSession() },
        { title: 'Reset', onClick: () => hooks.resetToDefaults() }
    ]);

    syncModeUI();

    document.body.appendChild(panel.element);
    document.body.appendChild(fab);
    fab.addEventListener('click', toggle);

    // Keep live readouts (e.g. sensor status) fresh.
    setInterval(() => panel.poll(), 200);

    return {
        element: panel.element,
        refresh: () => { panel.refresh(); syncModeUI(); syncRepr(); },
        toggle
    };
}
