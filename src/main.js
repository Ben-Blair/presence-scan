import {
    Application,
    Asset,
    BoundingBox,
    Color,
    Entity,
    Keyboard,
    Mouse,
    StandardMaterial,
    TouchDevice,
    Vec3,
    EVENT_KEYDOWN,
    FILLMODE_FILL_WINDOW,
    KEY_1,
    KEY_2,
    KEY_3,
    KEY_4,
    KEY_F,
    KEY_H,
    KEY_O,
    RESOLUTION_AUTO
} from 'playcanvas';
import { CameraControls } from './camera-controls.js';

import { params } from './params.js';
import { applyParams, resolveStartup, resetToDefaults, saveSession } from './settings-store.js';
import { Orb } from './orb.js';
import { SplatFX } from './splat-effects.js';
import { OrbSources } from './orb-sources.js';
import { WaypointCamera } from './waypoint-camera.js';
import { createSettingsPanel } from './settings.js';

const canvas = document.getElementById('app-canvas');
const loadingEl = document.getElementById('loading');
const progressEl = document.getElementById('loading-progress');

const app = new Application(canvas, {
    mouse: new Mouse(canvas),
    keyboard: new Keyboard(window),
    touch: new TouchDevice(canvas),
    graphicsDeviceOptions: { antialias: false }
});
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, params.camera.renderScale);
window.addEventListener('resize', () => app.resizeCanvas());

app.scene.ambientLight = new Color(0.3, 0.3, 0.3);

// stop the context menu so right-drag panning works
canvas.addEventListener('contextmenu', e => e.preventDefault());

const assets = {
    garage: new Asset('garage', 'gsplat', { url: 'assets/garage.sog' }),
    collision: new Asset('collision', 'container', { url: 'assets/garagecollisionmesh.glb' })
};

let loaded = 0;
const total = Object.keys(assets).length;

function onAllLoaded() {
    buildScene();
    loadingEl.classList.add('hidden');
}

for (const key in assets) {
    const asset = assets[key];
    asset.on('load', () => {
        loaded++;
        progressEl.style.width = `${(loaded / total) * 100}%`;
        if (loaded === total) onAllLoaded();
    });
    asset.on('error', (err) => {
        console.error(`Failed to load ${key}:`, err);
        loadingEl.querySelector('.label').textContent = `Failed to load ${key} — see console`;
    });
    app.assets.add(asset);
    app.assets.load(asset);
}

const startup = resolveStartup();
applyParams(params, startup.params);

app.start();

function buildScene() {
    // ---------------------------------------------------------- splat
    const splat = new Entity('garage-splat');
    splat.addComponent('gsplat', { asset: assets.garage });
    // standard 3DGS PLY data is y-down; flip it upright
    splat.setLocalEulerAngles(180, 0, 0);
    app.root.addChild(splat);

    // ---------------------------------------------------------- occluder
    // invisible depth-only render of the collision mesh: gives the orb crisp
    // occlusion behind walls/objects. Also the most reliable source of the
    // actual room bounds (the raw splat AABB is bloated by floater outliers).
    const occluder = assets.collision.resource.instantiateRenderEntity();
    occluder.name = 'depth-occluder';
    app.root.addChild(occluder);

    const worldAabb = new BoundingBox();
    let aabbInit = false;
    occluder.findComponents('render').forEach((render) => {
        render.meshInstances.forEach((mi) => {
            if (!aabbInit) {
                worldAabb.copy(mi.aabb);
                aabbInit = true;
            } else {
                worldAabb.add(mi.aabb);
            }
        });
    });
    if (!aabbInit) {
        worldAabb.setFromTransformedAabb(assets.garage.resource.aabb, splat.getWorldTransform());
    }
    const center = worldAabb.center.clone();
    const halfExtents = worldAabb.halfExtents.clone();
    params.source.floorY = worldAabb.getMin().y + 0.05;

    // Auto-derive default zones from the runtime room bounds when none are
    // configured. The splat's world coordinates aren't known until load, so
    // hand-hardcoding boxes up front is impractical. This partitions the floor
    // into four quadrants and mounts each quadrant's camera high in the
    // diagonally-opposite room corner, so it looks *across* the room at an
    // oblique security-camera angle rather than straight down. Captured/edited
    // anchors (persisted via the settings store in params.camera.anchors)
    // override these.
    if (params.camera.anchors.length === 0) {
        const ceilingY = center.y + halfExtents.y - 0.3;
        const inset = 0.4; // keep the camera off the corner walls a touch
        const minX = center.x - halfExtents.x;
        const maxX = center.x + halfExtents.x;
        const minZ = center.z - halfExtents.z;
        const maxZ = center.z + halfExtents.z;

        // each zone: floor quadrant box + the opposite corner it's viewed from
        const zones = [
            { name: 'NW', box: { minX, minZ, maxX: center.x, maxZ: center.z }, corner: { x: maxX, z: maxZ } },
            { name: 'NE', box: { minX: center.x, minZ, maxX, maxZ: center.z }, corner: { x: minX, z: maxZ } },
            { name: 'SW', box: { minX, minZ: center.z, maxX: center.x, maxZ }, corner: { x: maxX, z: minZ } },
            { name: 'SE', box: { minX: center.x, minZ: center.z, maxX, maxZ }, corner: { x: minX, z: minZ } }
        ];
        for (const z of zones) {
            // inset the corner toward room center so the camera sits just inside
            const eye = {
                x: z.corner.x + Math.sign(center.x - z.corner.x) * inset,
                y: ceilingY,
                z: z.corner.z + Math.sign(center.z - z.corner.z) * inset
            };
            params.camera.anchors.push({ name: z.name, box: z.box, eye });
        }
    }

    // ---------------------------------------------------------- camera
    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.03, 0.03, 0.05),
        fov: params.camera.fov,
        nearClip: 0.05,
        farClip: 1000
    });
    app.root.addChild(camera);

    const view = startup.view;
    const fallbackOrb = new Vec3(center.x, params.source.floorY + params.orb.height, center.z);
    const spawnEye = new Vec3(view.position.x, view.position.y, view.position.z);
    const spawnFocus = new Vec3(view.focus.x, view.focus.y, view.focus.z);
    const orbStart = view.orb
        ? new Vec3(view.orb.x, view.orb.y, view.orb.z)
        : fallbackOrb;
    camera.setPosition(spawnEye);

    camera.addComponent('script');
    const controls = camera.script.create(CameraControls, {
        properties: {
            moveSpeed: params.camera.moveSpeed,
            moveFastSpeed: params.camera.moveFastSpeed,
            rotateSpeed: params.camera.rotateSpeed,
            zoomRange: { x: 0.1, y: 60 }
        }
    });
    controls.reset(spawnFocus, spawnEye);

    // ---------------------------------------------------------- orb
    const orb = new Orb(app);
    orb.applyParams(params.orb);
    orb.teleport(orbStart);

    // ---------------------------------------------------------- splat fx
    const splatFX = new SplatFX(app, splat);
    splatFX.apply();
    {
        // expand the room box a little so wall/floor splats survive the
        // dollhouse fade
        const margin = 0.4;
        const min = worldAabb.getMin().clone();
        const max = worldAabb.getMax().clone();
        min.x -= margin; min.y -= margin; min.z -= margin;
        max.x += margin; max.y += margin; max.z += margin;
        splatFX.setRoomBounds(min, max);
    }

    // depth-only material for the occluder
    const depthOnly = new StandardMaterial();
    depthOnly.redWrite = false;
    depthOnly.greenWrite = false;
    depthOnly.blueWrite = false;
    depthOnly.alphaWrite = false;
    depthOnly.depthWrite = true;
    // push the occluder surface slightly away from the camera so it sits
    // behind the splat "fuzz" instead of clipping it
    depthOnly.depthBias = 0.6;
    depthOnly.slopeDepthBias = 1.0;
    depthOnly.update();
    occluder.findComponents('render').forEach((render) => {
        render.meshInstances.forEach((mi) => {
            mi.material = depthOnly;
            mi.castShadow = false;
        });
    });
    occluder.enabled = params.occluder.enabled;

    // ---------------------------------------------------------- orb sources
    const sources = new OrbSources(app, camera, orb, params, { center, halfExtents });

    // ---------------------------------------------------------- waypoint cam
    const autoCam = new WaypointCamera(camera, controls, orb, { center, halfExtents }, params);

    const applyView = (viewSettings) => {
        const eye = new Vec3(viewSettings.position.x, viewSettings.position.y, viewSettings.position.z);
        const focus = new Vec3(viewSettings.focus.x, viewSettings.focus.y, viewSettings.focus.z);
        const orbPos = viewSettings.orb
            ? new Vec3(viewSettings.orb.x, viewSettings.orb.y, viewSettings.orb.z)
            : new Vec3(center.x, params.source.floorY + params.orb.height, center.z);
        camera.setPosition(eye);
        controls.reset(focus, eye);
        orb.teleport(orbPos);
    };

    const saveCurrentSession = () => {
        saveSession({
            position: camera.getPosition(),
            focus: controls.focusPoint.clone(),
            orb: orb.getPosition()
        }, params);
        console.info('Saved settings for next load (view + controls). Reload to apply.');
    };

    // capture the current camera position as a zone's anchor eye. Turn anchor
    // follow OFF, fly the manual camera to an ideal vantage, then capture (zone
    // number key, or the panel button). Persists via the session store.
    const captureAnchor = (i) => {
        const anchor = params.camera.anchors[i];
        if (!anchor) {
            console.warn(`No zone ${i + 1} to capture (only ${params.camera.anchors.length} zones).`);
            return;
        }
        if (params.camera.orbitOrb) {
            console.warn('Turn "anchor follow" off before capturing — the camera is auto-driven while it is on.');
            return;
        }
        const p = camera.getPosition();
        anchor.eye = { x: p.x, y: p.y, z: p.z };
        saveCurrentSession();
        console.info(`Captured camera position for zone "${anchor.name}".`);
    };

    // ---------------------------------------------------------- settings
    const hooks = {
        sources,
        captureAnchor,
        onOrbChanged: () => orb.applyParams(params.orb),
        onCameraChanged: () => {
            controls.moveSpeed = params.camera.moveSpeed;
            controls.moveFastSpeed = params.camera.moveFastSpeed;
            controls.rotateSpeed = params.camera.rotateSpeed;
            camera.camera.fov = params.camera.fov;
            app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, params.camera.renderScale);
            app.resizeCanvas();
        },
        onOccluderChanged: () => {
            occluder.enabled = params.occluder.enabled;
        },
        onSourceModeChanged: () => {
            if (params.source.mode === 'sensor') {
                sources.connectSensor();
            } else {
                sources.disconnectSensor();
            }
        },
        connectSensor: () => sources.connectSensor(),
        disconnectSensor: () => sources.disconnectSensor(),
        frameOrb: () => controls.focus(orb.getPosition()),
        saveSession: saveCurrentSession,
        resetToDefaults: () => {
            applyView(resetToDefaults(params));
            hooks.onOrbChanged();
            hooks.onCameraChanged();
            hooks.onOccluderChanged();
            hooks.onSourceModeChanged();
            pane.refresh();
            console.info('Reset to defaults.json.');
        }
    };
    const pane = createSettingsPanel(params, hooks);

    // ---------------------------------------------------------- hotkeys
    app.keyboard.on(EVENT_KEYDOWN, (e) => {
        if (e.key === KEY_F) {
            controls.focus(orb.getPosition());
        } else if (e.key === KEY_O) {
            params.camera.orbitOrb = !params.camera.orbitOrb;
            pane.refresh();
        } else if (e.key === KEY_H) {
            saveCurrentSession();
        } else if (e.key === KEY_1) {
            captureAnchor(0);
        } else if (e.key === KEY_2) {
            captureAnchor(1);
        } else if (e.key === KEY_3) {
            captureAnchor(2);
        } else if (e.key === KEY_4) {
            captureAnchor(3);
        }
    });

    // debug handle for console inspection
    window.__viewer = { app, splat, occluder, camera, controls, orb, sources, autoCam, center, halfExtents, params };

    // ---------------------------------------------------------- per-frame
    const roomBox = new BoundingBox(center.clone(), halfExtents.clone());

    const round = (v, step) => Math.round(v / step) * step;

    app.on('update', (dt) => {
        sources.update(dt);
        orb.update(dt, params.orb.smoothing);

        // anchor follow mode: drive the camera automatically (suspends the
        // manual CameraControls while active)
        if (params.camera.orbitOrb !== autoCam.active) {
            if (params.camera.orbitOrb) {
                autoCam.start();
            } else {
                autoCam.stop();
            }
        }
        autoCam.update(dt);

        const orbPos = orb.getPosition();
        const camPos = camera.getPosition();

        // cutaway state
        const outside = !roomBox.containsPoint(camPos);
        const cutOn = params.cutaway.mode === 'on' ||
            (params.cutaway.mode === 'auto' && outside);

        // the depth occluder blocks the view into the room from outside, so
        // suspend it while the cutaway is active
        occluder.enabled = params.occluder.enabled && !cutOn;

        // push shader uniforms (quantized; only re-renders splat when changed)
        splatFX.setParams([
            round(orbPos.x, 0.01), round(orbPos.y, 0.01), round(orbPos.z, 0.01),
            params.orb.color.r, params.orb.color.g, params.orb.color.b,
            params.orb.glowIntensity, params.orb.glowRadius,
            cutOn ? 1 : 0,
            cutOn ? round(camPos.x, 0.03) : 0,
            cutOn ? round(camPos.y, 0.03) : 0,
            cutOn ? round(camPos.z, 0.03) : 0,
            cutOn ? round(orbPos.x, 0.03) : 0,
            cutOn ? round(orbPos.y, 0.03) : 0,
            cutOn ? round(orbPos.z, 0.03) : 0,
            params.cutaway.distance, params.cutaway.softness,
            round(camPos.x, 0.01), round(camPos.y, 0.01), round(camPos.z, 0.01),
            params.orb.glowFacing
        ]);
    });
}
