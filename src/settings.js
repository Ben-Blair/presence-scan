import { Pane } from 'tweakpane';

/**
 * Builds the Tweakpane settings panel bound to the shared params object.
 *
 * @param {*} params - the shared params object
 * @param {*} hooks - callbacks: onOrbChanged(), onCameraChanged(), onOccluderChanged(),
 *                    onSourceModeChanged(), connectSensor(), disconnectSensor(), frameOrb(),
 *                    and sources (for sensor status readout)
 */
export function createSettingsPanel(params, hooks) {
    const pane = new Pane({ title: 'Garage Viewer', expanded: true });

    const session = pane.addFolder({ title: 'Session' });
    session.addButton({ title: 'Save for next load (H)' }).on('click', () => hooks.saveSession());
    session.addButton({ title: 'Reset to defaults' }).on('click', () => hooks.resetToDefaults());

    // --- Orb ---
    const orb = pane.addFolder({ title: 'Orb' });
    orb.addBinding(params.orb, 'color', { color: { type: 'float' }, label: 'color' });
    orb.addBinding(params.orb, 'size', { min: 0.02, max: 0.5, step: 0.01 });
    orb.addBinding(params.orb, 'coreBrightness', { min: 0, max: 8, step: 0.1, label: 'brightness' });
    orb.addBinding(params.orb, 'glowIntensity', { min: 0, max: 6, step: 0.05, label: 'splat glow' });
    orb.addBinding(params.orb, 'glowRadius', { min: 0.1, max: 6, step: 0.05, label: 'glow radius' });
    orb.addBinding(params.orb, 'glowFacing', { min: 0, max: 1, step: 0.05, label: 'glow facing' });
    orb.addBinding(params.orb, 'height', { min: 0, max: 3, step: 0.05, label: 'height (m)' });
    orb.addBinding(params.orb, 'smoothing', { min: 0.5, max: 20, step: 0.5 });
    orb.on('change', () => hooks.onOrbChanged());

    // --- Camera ---
    const cam = pane.addFolder({ title: 'Camera' });
    cam.addBinding(params.camera, 'fov', { min: 20, max: 120, step: 1, label: 'FOV' });
    cam.addBinding(params.camera, 'orbitOrb', { label: 'anchor follow (O)' });
    cam.addBinding(params.camera, 'moveSpeed', { min: 0.5, max: 20, step: 0.5, label: 'speed' });
    cam.addBinding(params.camera, 'moveFastSpeed', { min: 1, max: 40, step: 0.5, label: 'fast speed' });
    cam.addBinding(params.camera, 'rotateSpeed', { min: 0.05, max: 1, step: 0.05, label: 'look speed' });
    cam.addBinding(params.camera, 'renderScale', { min: 0.5, max: 2, step: 0.25, label: 'render scale' });
    cam.addButton({ title: 'Frame orb (F)' }).on('click', () => hooks.frameOrb());

    const way = cam.addFolder({ title: 'Anchor camera', expanded: false });
    way.addBinding(params.camera.waypoint, 'railSmoothing', { min: 0.5, max: 8, step: 0.1, label: 'rail follow speed' });
    way.addBinding(params.camera.waypoint, 'parkBias', { min: 0, max: 1, step: 0.05, label: 'stick at corners' });
    way.addBinding(params.camera.waypoint, 'lookSmoothing', { min: 0.5, max: 12, step: 0.5, label: 'aim speed' });

    // Set each zone's camera position by hand: turn anchor follow off, fly the
    // camera to a good vantage, then click (or press the zone number key).
    const place = way.addFolder({ title: 'Set camera positions', expanded: true });
    params.camera.anchors.forEach((anchor, i) => {
        place.addButton({ title: `Set "${anchor.name}" here (${i + 1})` })
            .on('click', () => hooks.captureAnchor(i));
    });

    cam.on('change', () => hooks.onCameraChanged());

    // --- Cutaway ---
    const cut = pane.addFolder({ title: 'Cutaway (see inside)' });
    cut.addBinding(params.cutaway, 'mode', {
        options: { Auto: 'auto', On: 'on', Off: 'off' }
    });
    cut.addBinding(params.cutaway, 'distance', { min: 0.5, max: 10, step: 0.1, label: 'keep distance' });
    cut.addBinding(params.cutaway, 'softness', { min: 0.05, max: 4, step: 0.05 });
    cut.addBinding(params.cutaway, 'wallCut', { min: 0.2, max: 3, step: 0.05, label: 'wall peel' });

    // --- Occlusion ---
    const occ = pane.addFolder({ title: 'Occlusion' });
    occ.addBinding(params.occluder, 'enabled', { label: 'depth mesh (experimental)' });
    occ.on('change', () => hooks.onOccluderChanged());

    // --- Orb position source ---
    const src = pane.addFolder({ title: 'Orb Position Source' });
    src.addBinding(params.source, 'mode', {
        options: { 'Click to place': 'click', 'Demo path': 'demo', 'mmWave sensor': 'sensor' }
    }).on('change', () => hooks.onSourceModeChanged());
    src.addBinding(params.source, 'demoSpeed', { min: 0.05, max: 2, step: 0.05, label: 'demo speed' });
    src.addBinding(params.source, 'floorY', { min: -5, max: 5, step: 0.01, label: 'floor height' });

    const sensor = src.addFolder({ title: 'HLK mmWave (WebSocket)', expanded: false });
    sensor.addBinding(params.source.sensor, 'url');
    sensor.addBinding(params.source.sensor, 'originX', { min: -20, max: 20, step: 0.05 });
    sensor.addBinding(params.source.sensor, 'originZ', { min: -20, max: 20, step: 0.05 });
    sensor.addBinding(params.source.sensor, 'rotationDeg', { min: -180, max: 180, step: 1 });
    sensor.addBinding(params.source.sensor, 'scale', { min: 0.0001, max: 0.01, step: 0.0001, format: v => v.toFixed(4) });
    sensor.addButton({ title: 'Connect' }).on('click', () => hooks.connectSensor());
    sensor.addButton({ title: 'Disconnect' }).on('click', () => hooks.disconnectSensor());
    sensor.addBinding(hooks.sources, 'sensorStatus', { readonly: true, label: 'status' });

    return pane;
}
