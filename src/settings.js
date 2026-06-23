import './panel.css';
import { createPanel } from './panel-controls.js';

/**
 * Builds the custom settings panel bound to the shared params object.
 *
 * @param {*} params - the shared params object
 * @param {*} hooks - callbacks: onOrbChanged(), onCameraChanged(),
 *                    onSourceModeChanged(), connectSensor(), disconnectSensor(), frameOrb(),
 *                    captureAnchor(i), saveSession(), resetToDefaults(),
 *                    and sources (for the sensor status readout)
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
    }

    const panel = createPanel({ title: 'Garage Viewer', onHide: toggle });

    // --- Session ---
    const session = panel.addSection({ title: 'Session' });
    session.addButton({ title: 'Save for next load (H)', onClick: () => hooks.saveSession() });
    session.addButton({ title: 'Reset to defaults', onClick: () => hooks.resetToDefaults() });

    // --- Orb ---
    const onOrb = () => hooks.onOrbChanged();
    const orb = panel.addSection({ title: 'Orb' });
    orb.addColor(params.orb, 'color', { label: 'color', onChange: onOrb });
    orb.addSlider(params.orb, 'size', { min: 0.02, max: 0.5, step: 0.01, onChange: onOrb });
    orb.addSlider(params.orb, 'coreBrightness', { min: 0, max: 8, step: 0.1, label: 'brightness', onChange: onOrb });
    orb.addSlider(params.orb, 'glowIntensity', { min: 0, max: 6, step: 0.05, label: 'splat glow', onChange: onOrb });
    orb.addSlider(params.orb, 'glowRadius', { min: 0.1, max: 6, step: 0.05, label: 'glow radius', onChange: onOrb });
    orb.addSlider(params.orb, 'glowFacing', { min: 0, max: 1, step: 0.05, label: 'glow facing', onChange: onOrb });
    orb.addSlider(params.orb, 'height', { min: 0, max: 3, step: 0.05, label: 'height (m)', onChange: onOrb });
    orb.addSlider(params.orb, 'smoothing', { min: 0.5, max: 20, step: 0.5, onChange: onOrb });

    // --- Camera ---
    const onCam = () => hooks.onCameraChanged();
    const cam = panel.addSection({ title: 'Camera' });
    cam.addSlider(params.camera, 'fov', { min: 20, max: 120, step: 1, label: 'FOV', onChange: onCam });
    cam.addToggle(params.camera, 'orbitOrb', { label: 'anchor follow (O)', onChange: onCam });
    cam.addSlider(params.camera, 'moveSpeed', { min: 0.5, max: 20, step: 0.5, label: 'speed', onChange: onCam });
    cam.addSlider(params.camera, 'moveFastSpeed', { min: 1, max: 40, step: 0.5, label: 'fast speed', onChange: onCam });
    cam.addSlider(params.camera, 'rotateSpeed', { min: 0.05, max: 1, step: 0.05, label: 'look speed', onChange: onCam });
    cam.addSlider(params.camera, 'renderScale', { min: 0.5, max: 2, step: 0.25, label: 'render scale', onChange: onCam });
    cam.addButton({ title: 'Frame orb (F)', onClick: () => hooks.frameOrb() });

    const way = cam.addSection({ title: 'Anchor camera', expanded: false });
    way.addSlider(params.camera.waypoint, 'railSmoothing', { min: 0.5, max: 8, step: 0.1, label: 'rail follow speed', onChange: onCam });
    way.addSlider(params.camera.waypoint, 'parkBias', { min: 0, max: 1, step: 0.05, label: 'stick at corners', onChange: onCam });
    way.addSlider(params.camera.waypoint, 'lookSmoothing', { min: 0.5, max: 12, step: 0.5, label: 'aim speed', onChange: onCam });

    // Set each zone's camera position by hand: turn anchor follow off, fly the
    // camera to a good vantage, then click (or press the zone number key).
    const place = way.addSection({ title: 'Set camera positions', expanded: true });
    params.camera.anchors.forEach((anchor, i) => {
        place.addButton({ title: `Set "${anchor.name}" here (${i + 1})`, onClick: () => hooks.captureAnchor(i) });
    });

    // --- Cutaway ---
    const cut = panel.addSection({ title: 'Cutaway (see inside)' });
    cut.addSelect(params.cutaway, 'mode', { options: { Auto: 'auto', On: 'on', Off: 'off' } });
    cut.addSlider(params.cutaway, 'distance', { min: 0.5, max: 10, step: 0.1, label: 'keep distance' });
    cut.addSlider(params.cutaway, 'softness', { min: 0.05, max: 4, step: 0.05 });
    cut.addSlider(params.cutaway, 'wallCut', { min: 0.2, max: 3, step: 0.05, label: 'wall peel' });

    // --- Orb position source ---
    const src = panel.addSection({ title: 'Orb Position Source' });
    src.addSelect(params.source, 'mode', {
        options: { 'Click to place': 'click', 'Demo path': 'demo', 'mmWave sensor': 'sensor' },
        onChange: () => hooks.onSourceModeChanged()
    });
    src.addSlider(params.source, 'demoSpeed', { min: 0.05, max: 2, step: 0.05, label: 'demo speed' });
    src.addSlider(params.source, 'floorY', { min: -5, max: 5, step: 0.01, label: 'floor height' });

    const sensor = src.addSection({ title: 'HLK mmWave (WebSocket)', expanded: false });
    sensor.addText(params.source.sensor, 'url', { label: 'url' });
    sensor.addSlider(params.source.sensor, 'originX', { min: -20, max: 20, step: 0.05, label: 'originX' });
    sensor.addSlider(params.source.sensor, 'originZ', { min: -20, max: 20, step: 0.05, label: 'originZ' });
    sensor.addSlider(params.source.sensor, 'rotationDeg', { min: -180, max: 180, step: 1, label: 'rotationDeg' });
    sensor.addSlider(params.source.sensor, 'scale', { min: 0.0001, max: 0.01, step: 0.0001, label: 'scale', format: (v) => v.toFixed(4) });
    sensor.addToggle(params.source.sensor, 'flipSensorY', { label: 'mirror Y' });
    sensor.addButton({ title: 'Connect', onClick: () => hooks.connectSensor() });
    sensor.addButton({ title: 'Disconnect', onClick: () => hooks.disconnectSensor() });
    sensor.addReadout({ label: 'status', get: () => hooks.sources.sensorStatus });

    document.body.appendChild(panel.element);
    document.body.appendChild(fab);
    fab.addEventListener('click', toggle);

    // Keep live readouts (e.g. sensor status) fresh.
    setInterval(() => panel.poll(), 200);

    return {
        element: panel.element,
        refresh: () => panel.refresh(),
        toggle
    };
}
