import {
    Application,
    Asset,
    BoundingBox,
    Color,
    Entity,
    Keyboard,
    Mouse,
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
    KEY_P,
    RESOLUTION_AUTO
} from 'playcanvas';
import { CameraControls } from './camera-controls.js';

import { params } from './params.js';
import { applyParams, resolveStartup, resetToDefaults, saveSession } from './settings-store.js';
import { Orb } from './orb.js';
import { SplatFX } from './splat-effects.js';
import { OrbSources } from './orb-sources.js';
import { WaypointCamera } from './waypoint-camera.js';
import { SensorMinimap } from './sensor-minimap.js';
import { SensorOverlay } from './sensor-overlay.js';
import { createSettingsPanel } from './settings.js';
import { isTypingInPanel } from './dom-utils.js';

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

    // ---------------------------------------------------------- room bounds
    // the collision mesh gives the true room bounds (the raw splat AABB is
    // bloated by floater outliers); it's only used for measurement, never
    // rendered.
    const collisionMesh = assets.collision.resource.instantiateRenderEntity();
    app.root.addChild(collisionMesh);
    let worldAabb = deriveRoomBounds(collisionMesh);
    if (!worldAabb) {
        worldAabb = new BoundingBox();
        worldAabb.setFromTransformedAabb(assets.garage.resource.aabb, splat.getWorldTransform());
    }
    collisionMesh.destroy();
    const center = worldAabb.center.clone();
    const halfExtents = worldAabb.halfExtents.clone();
    params.source.floorY = worldAabb.getMin().y + 0.05;

    // ---------------------------------------------------------- anchors
    // Auto-derive default zones from the runtime room bounds when none are
    // configured. Captured/edited anchors (persisted via the settings store in
    // params.camera.anchors) override these.
    if (params.camera.anchors.length === 0) {
        params.camera.anchors.push(...generateDefaultAnchors(center, halfExtents));
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
    // the cutaway peel anchors to the near wall, so it needs the true wall line
    // (a tiny margin keeps the wall surface splats themselves on the solid side)
    {
        const margin = 0.05;
        const min = worldAabb.getMin().clone();
        const max = worldAabb.getMax().clone();
        min.x -= margin; min.y -= margin; min.z -= margin;
        max.x += margin; max.y += margin; max.z += margin;
        splatFX.setRoomBounds(min, max);
    }

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

    // ---------------------------------------------------------- sensor minimap
    // Bottom-left radar plot of the live mmWave stream (LD2450-app style) so
    // you can confirm the sensor sees you and tracks accurately. Visible only
    // while the orb source is the sensor.
    const minimap = new SensorMinimap(sources, params);
    sources.onStatusChange = () => minimap.wake();
    minimap.mount();

    // In-scene gizmo of where the program thinks the sensor is (marker + facing
    // + FOV cone) plus a live line to the tracked object, for visually fine-tuning
    // the sensor placement against the scan.
    const sensorOverlay = new SensorOverlay(app, params, orb, sources);

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
        onSourceModeChanged: () => {
            if (params.source.mode === 'sensor') {
                sources.connectSensor();
            } else {
                sources.disconnectSensor();
            }
            minimap.wake();
        },
        connectSensor: () => {
            sources.connectSensor();
            minimap.wake();
        },
        disconnectSensor: () => {
            sources.disconnectSensor();
            minimap.wake();
        },
        frameOrb: () => controls.focus(orb.getPosition()),
        saveSession: saveCurrentSession,
        resetToDefaults: () => {
            applyView(resetToDefaults(params));
            hooks.onOrbChanged();
            hooks.onCameraChanged();
            hooks.onSourceModeChanged();
            pane.refresh();
            console.info('Reset to defaults.json.');
        }
    };
    const pane = createSettingsPanel(params, hooks);

    // ---------------------------------------------------------- hotkeys
    wireHotkeys({ pane, controls, orb, captureAnchor, saveCurrentSession });

    // debug handle for console inspection
    window.__viewer = { app, splat, camera, controls, orb, sources, autoCam, minimap, sensorOverlay, center, halfExtents, params };

    // ---------------------------------------------------------- per-frame
    // auto-cutaway engages only when the camera is clearly OUTSIDE the room, so
    // moving around (or near a wall) inside never trips it. The box is inflated
    // by an engage margin that matches the shader's own outside-face test.
    const engageMargin = 0.3;
    const roomBox = new BoundingBox(
        center.clone(),
        halfExtents.clone().add(new Vec3(engageMargin, engageMargin, engageMargin))
    );

    const round = (v, step) => Math.round(v / step) * step;

    app.on('update', (dt) => {
        sources.update(dt);
        orb.update(dt, params.orb.smoothing);
        sensorOverlay.update();

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

        // cutaway state. While anchor follow drives the camera we want a solid
        // interior view, so auto-cutaway is suppressed (it would peel the walls
        // and make the room look like a see-through box from outside).
        const outside = !roomBox.containsPoint(camPos);
        const cutOn = !autoCam.active && (
            params.cutaway.mode === 'on' ||
            (params.cutaway.mode === 'auto' && outside));

        // push shader uniforms (quantized; only re-renders splat when changed).
        // viewPos drives glow-facing only — coarsen it and freeze when unused so
        // camera motion doesn't trigger a gsplat resort every frame.
        const glowFacingOn = params.orb.glowIntensity > 0 && params.orb.glowFacing > 0;
        const orbStep = params.source.mode === 'click' ? 0.01 : 0.02;
        splatFX.setParams({
            orbPos: [round(orbPos.x, orbStep), round(orbPos.y, orbStep), round(orbPos.z, orbStep)],
            orbColor: [params.orb.color.r, params.orb.color.g, params.orb.color.b],
            orbIntensity: params.orb.glowIntensity,
            orbRadius: params.orb.glowRadius,
            cutEnabled: cutOn ? 1 : 0,
            cutCamPos: [
                cutOn ? round(camPos.x, 0.03) : 0,
                cutOn ? round(camPos.y, 0.03) : 0,
                cutOn ? round(camPos.z, 0.03) : 0
            ],
            wallPeelPos: [params.cutaway.wallPeels.xPos, params.cutaway.wallPeels.yPos, params.cutaway.wallPeels.zPos],
            wallPeelNeg: [params.cutaway.wallPeels.xNeg, params.cutaway.wallPeels.yNeg, params.cutaway.wallPeels.zNeg],
            cutSoft: params.cutaway.softness,
            cutEngage: params.cutaway.engage,
            viewPos: glowFacingOn
                ? [round(camPos.x, 0.05), round(camPos.y, 0.05), round(camPos.z, 0.05)]
                : [0, 0, 0],
            glowFacing: params.orb.glowFacing
        });
    });
}

/**
 * Measure the true room bounds from the collision mesh's render instances.
 * Returns the world-space AABB, or null if the mesh has no renderables (the
 * caller then falls back to the splat AABB).
 */
function deriveRoomBounds(collisionMesh) {
    const worldAabb = new BoundingBox();
    let aabbInit = false;
    collisionMesh.findComponents('render').forEach((render) => {
        render.meshInstances.forEach((mi) => {
            if (!aabbInit) {
                worldAabb.copy(mi.aabb);
                aabbInit = true;
            } else {
                worldAabb.add(mi.aabb);
            }
        });
    });
    return aabbInit ? worldAabb : null;
}

/**
 * Build four default anchor zones from the runtime room bounds. The splat's
 * world coordinates aren't known until load, so hand-hardcoding boxes up front
 * is impractical. This partitions the floor into four quadrants and mounts each
 * quadrant's camera high in the diagonally-opposite room corner, so it looks
 * *across* the room at an oblique security-camera angle rather than straight
 * down.
 */
function generateDefaultAnchors(center, halfExtents) {
    // Pull the corner eyes well clear of the wall/ceiling splat shell — splats
    // have thickness and fuzz, so a small fixed inset (0.3-0.4m) leaves the
    // camera embedded in the geometry. Scale the inset to the room and drop it a
    // solid amount below the ceiling, while keeping the high, diagonally-opposite
    // vantage for the oblique across-room angle.
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const ceilingY = center.y + halfExtents.y - clamp(halfExtents.y * 0.3, 0.7, 1.2);
    const inset = clamp(Math.min(halfExtents.x, halfExtents.z) * 0.2, 0.8, 1.5);
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
    return zones.map((z) => ({
        name: z.name,
        box: z.box,
        // inset the corner toward room center so the camera sits just inside
        eye: {
            x: z.corner.x + Math.sign(center.x - z.corner.x) * inset,
            y: ceilingY,
            z: z.corner.z + Math.sign(center.z - z.corner.z) * inset
        }
    }));
}

/** Wire the global keyboard shortcuts. */
function wireHotkeys({ pane, controls, orb, captureAnchor, saveCurrentSession }) {
    app.keyboard.on(EVENT_KEYDOWN, (e) => {
        if (isTypingInPanel()) return;
        if (e.key === KEY_P) {
            pane.toggle();
        } else if (e.key === KEY_F) {
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
}
