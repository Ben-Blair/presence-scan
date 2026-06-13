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
    KEY_F,
    KEY_H,
    KEY_O,
    RESOLUTION_AUTO
} from 'playcanvas';
import { CameraControls } from './camera-controls.js';

import { params } from './params.js';
import { loadSpawnView, saveSpawnView } from './spawn-view.js';
import { Orb } from './orb.js';
import { SplatFX } from './splat-effects.js';
import { OrbSources } from './orb-sources.js';
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

    // ---------------------------------------------------------- camera
    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.03, 0.03, 0.05),
        fov: 75,
        nearClip: 0.05,
        farClip: 1000
    });
    app.root.addChild(camera);

    const orbStart = new Vec3(center.x, params.source.floorY + params.orb.height, center.z);
    const defaultEye = new Vec3(center.x + halfExtents.x * 0.4, params.source.floorY + 1.6, center.z + halfExtents.z * 0.4);
    const defaultFocus = orbStart.clone();

    const savedView = loadSpawnView();
    const spawnEye = savedView
        ? new Vec3(savedView.position.x, savedView.position.y, savedView.position.z)
        : defaultEye.clone();
    const spawnFocus = savedView
        ? new Vec3(savedView.focus.x, savedView.focus.y, savedView.focus.z)
        : defaultFocus.clone();
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

    // ---------------------------------------------------------- settings
    const hooks = {
        sources,
        onOrbChanged: () => orb.applyParams(params.orb),
        onCameraChanged: () => {
            controls.moveSpeed = params.camera.moveSpeed;
            controls.moveFastSpeed = params.camera.moveFastSpeed;
            controls.rotateSpeed = params.camera.rotateSpeed;
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
        frameOrb: () => controls.focus(orb.getPosition())
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
            saveSpawnView(camera.getPosition(), controls.focusPoint.clone());
            console.info('Saved spawn view (position + look-at). Reload to start here.');
        }
    });

    // debug handle for console inspection
    window.__viewer = { app, splat, occluder, camera, controls, orb, sources, center, halfExtents, params };

    // ---------------------------------------------------------- per-frame
    const lastOrbFocus = new Vec3(Infinity, Infinity, Infinity);
    const roomBox = new BoundingBox(center.clone(), halfExtents.clone());

    const round = (v, step) => Math.round(v / step) * step;

    app.on('update', (dt) => {
        sources.update(dt);
        orb.update(dt, camera, params.orb.smoothing);

        const orbPos = orb.getPosition();
        const camPos = camera.getPosition();

        // orbit-orb mode: keep the orb as the orbit pivot
        if (params.camera.orbitOrb && lastOrbFocus.distance(orbPos) > 0.05) {
            lastOrbFocus.copy(orbPos);
            controls.focusPoint = orbPos;
        }

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
            params.cutaway.distance, params.cutaway.softness
        ]);
    });
}
