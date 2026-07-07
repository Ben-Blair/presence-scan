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
    KEY_V,
    RESOLUTION_AUTO
} from 'playcanvas';
import { CameraControls } from './camera-controls.js';

import { params } from './params.js';
import { applyParams, resolveStartup, resetToDefaults, saveSession } from './settings-store.js';
import { OrbField } from './orb-field.js';
import { CharacterField } from './character.js';
import { SplatFX } from './splat-effects.js';
import { OrbSources } from './orb-sources.js';
import { buildNavGridFromColumns, emptyGrid, estimateFloorY } from './nav-grid.js';
import { NavDebugOverlay } from './nav-debug.js';
import { insetBoundsXZ, CUTAWAY_ENGAGE_MARGIN } from './math-utils.js';
import { WaypointCamera } from './waypoint-camera.js';
import { SensorMinimap } from './sensor-minimap.js';
import { SensorOverlay } from './sensor-overlay.js';
import { createSettingsPanel } from './settings.js';
import { createKeybindingsBar } from './keybindings-bar.js';
import { isTypingInPanel } from './dom-utils.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app-canvas'));
const loadingEl = /** @type {HTMLElement} */ (document.getElementById('loading'));
const progressEl = /** @type {HTMLElement} */ (document.getElementById('loading-progress'));

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
    collision: new Asset('collision', 'container', { url: 'assets/garagecollisionmesh.glb' }),
    // walking-character representation (optional; toggled in settings). The
    // bitmoji mesh + separate idle/walk clips retarget onto it by joint name.
    bitmoji: new Asset('bitmoji', 'container', { url: 'assets/character/bitmoji.glb' }),
    charIdle: new Asset('char-idle', 'container', { url: 'assets/character/idle.glb' }),
    charWalk: new Asset('char-walk', 'container', { url: 'assets/character/walk.glb' })
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
        const label = loadingEl.querySelector('.label');
        if (label) label.textContent = `Failed to load ${key} — see console`;
    });
    app.assets.add(asset);
    app.assets.load(asset);
}

const startup = resolveStartup();
applyParams(params, startup.params);

// In the kiosk build (GitHub Pages) always start in demo mode regardless of
// any saved session, so the public URL is a clean presentation experience.
/* global __KIOSK__ */
if (typeof __KIOSK__ !== 'undefined' && __KIOSK__) {
    params.source.mode = 'demo';
}

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
    const collisionMesh = /** @type {any} */ (assets.collision.resource).instantiateRenderEntity();
    app.root.addChild(collisionMesh);
    let worldAabb = deriveRoomBounds(collisionMesh);
    if (!worldAabb) {
        worldAabb = new BoundingBox();
        worldAabb.setFromTransformedAabb(
            /** @type {any} */ (assets.garage.resource).aabb, splat.getWorldTransform());
    }
    const center = worldAabb.center.clone();
    const halfExtents = worldAabb.halfExtents.clone();
    params.source.floorY = worldAabb.getMin().y + 0.05;

    // ---------------------------------------------------------- nav grid
    // demo-mode occupancy grid, derived entirely from the gaussian splat centers
    // (no collision mesh) so obstacles match the visible scan by construction. A
    // cell is blocked when its column holds a *grounded* solid reaching the orb's
    // travel height (buildNavGridFromColumns): thin floor speckle and wall-hung
    // clutter floating above the floor are rejected, so the footprint hugs the
    // real object. The vertical extent is anchored to the real floor plane
    // estimated from the splats' y-density (params.source.floorY sits ~0.55m
    // lower — the room AABB min includes the driveway sloping away outside the
    // door). Sparse wall coverage can leave holes; buildNavGridFromColumns closes
    // small gaps (gapBridge) so the walkable flood-fill can't leak past the walls.
    const gsRes = /** @type {any} */ (assets.garage.resource);
    const useSplatNav = !!(gsRes && gsRes.hasCenters);
    collisionMesh.destroy(); // measured for room bounds only; never feeds the nav grid
    const splatMatrix = splat.getWorldTransform().data;
    const navBounds = insetBoundsXZ(center, halfExtents, 0.15);
    const estFloor = useSplatNav
        ? (estimateFloorY(gsRes.centers, splatMatrix, navBounds) ?? params.source.floorY)
        : params.source.floorY;
    const V_BIN = 0.1; // vertical bin height (m) for the column occupancy profile
    const navGridOpts = () => {
        const d = params.source.demo;
        const floor = estFloor + d.floorOffset;
        // the orb rides at floorY + orb.height; block columns that reach it
        const reachHeight = Math.max(V_BIN,
            (params.source.floorY + params.orb.height) - floor);
        return {
            ...navBounds,
            cell: d.gridCell,
            floorY: floor,
            vBin: V_BIN,
            reachHeight,
            groundGap: d.groundGap,
            gapBridge: d.gapBridge,
            inflate: d.clearance,
            // keep the slider's meaning stable across cell sizes (splats/area)
            minCount: Math.max(1, Math.round(d.minPerBin * (d.gridCell / 0.2) ** 2))
        };
    };
    const buildGrid = () => {
        const opts = navGridOpts();
        if (useSplatNav) return buildNavGridFromColumns(gsRes.centers, splatMatrix, opts);
        console.warn('[nav] splat has no CPU centers — demo runs with no obstacles');
        return emptyGrid(opts);
    };
    const buildStart = performance.now();
    let navGrid = buildGrid();
    console.info(`[nav] ${useSplatNav ? 'splat' : 'empty'} grid ${navGrid.cols}x${navGrid.rows} built in ` +
        `${(performance.now() - buildStart).toFixed(1)}ms, ` +
        `${navGrid.blocked.reduce((a, b) => a + b, 0)} blocked cells, ` +
        `floor est ${estFloor.toFixed(3)}`);

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
    // CameraControls is a custom ScriptType; treat the instance as loosely typed
    // so its bespoke props (reset/focus/moveSpeed/…) don't trip the base ScriptType.
    const controls = /** @type {any} */ (camera.script).create(CameraControls, {
        properties: {
            moveSpeed: params.camera.moveSpeed,
            moveFastSpeed: params.camera.moveFastSpeed,
            rotateSpeed: params.camera.rotateSpeed,
            zoomRange: { x: 0.1, y: 60 }
        }
    });
    controls.reset(spawnFocus, spawnEye);

    // ---------------------------------------------------------- orbs
    // Up to three orbs, one per tracked person (sensor mode). Click/demo modes
    // drive just the primary; single-target subsystems below follow primary().
    const field = new OrbField(app);
    field.applyParams(params.orb);
    field.primary().teleport(orbStart);
    const orb = field.primary();

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
    const sources = new OrbSources(app, camera, field, params, { center, halfExtents }, navGrid);

    // ---------------------------------------------------------- character
    // Optional walking-avatar representation: a universal orb<->character switch
    // (params.character.enabled). One avatar per tracked orb, mirroring the orb
    // field. In character mode the orb sphere is hidden while its entity keeps
    // easing and feeding position; the avatar stands on the real floor plane
    // (estFloor), not the orb's floating height.
    const characters = new CharacterField(
        app, assets.bitmoji.resource, assets.charIdle.resource, assets.charWalk.resource, params.character);
    const applyRepresentation = () => {
        const charMode = params.character.enabled;
        for (const o of field.orbs) o.setCoreVisible(!charMode);
        if (charMode) {
            characters.update(0, field, estFloor); // snap avatars onto the current orbs
        } else {
            characters.hideAll();
        }
    };
    applyRepresentation();

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

    // capture the current camera position as a zone's anchor eye. Turn Auto
    // Follow OFF, fly the manual camera to an ideal vantage, then capture (zone
    // number key, or the panel button). Persists via the session store.
    const captureAnchor = (i) => {
        const anchor = params.camera.anchors[i];
        if (!anchor) {
            console.warn(`No zone ${i + 1} to capture (only ${params.camera.anchors.length} zones).`);
            return;
        }
        if (params.camera.orbitOrb) {
            console.warn('Turn "Auto Follow" off before capturing — the camera is auto-driven while it is on.');
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
    const sensorOverlay = new SensorOverlay(app, params, field, sources);

    // Debug view of the nav grid + the demo orbs' live A* paths (demo mode
    // only, toggled from the panel).
    const navDebug = new NavDebugOverlay(app, params, navGrid, sources.demoWander);

    // ---------------------------------------------------------- settings
    const hooks = {
        sources,
        captureAnchor,
        onOrbChanged: () => field.applyParams(params.orb),
        onRepresentationChanged: applyRepresentation,
        onCharacterChanged: () => characters.applyParams(params.character),
        onCameraChanged: () => {
            controls.moveSpeed = params.camera.moveSpeed;
            controls.moveFastSpeed = params.camera.moveFastSpeed;
            controls.rotateSpeed = params.camera.rotateSpeed;
            /** @type {any} */ (camera.camera).fov = params.camera.fov;
            app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, params.camera.renderScale);
            app.resizeCanvas();
        },
        onNavChanged: () => {
            navGrid = buildGrid();
            sources.setNavGrid(navGrid);
            navDebug.setGrid(navGrid);
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
            hooks.onCharacterChanged();
            hooks.onRepresentationChanged();
            hooks.onCameraChanged();
            hooks.onSourceModeChanged();
            pane.refresh();
            console.info('Reset to defaults.json.');
        }
    };
    const pane = createSettingsPanel(params, hooks);

    // ---------------------------------------------------------- display mode
    // a clean presentation view that hides every on-screen overlay (panel,
    // minimap, help, in-scene sensor gizmo), leaving just the splat + orb.
    const displayMode = createDisplayToggle();

    // dynamic keybindings hint bar (rebuilds only when mode / auto-follow change)
    const helpBar = createKeybindingsBar(params);

    // ---------------------------------------------------------- hotkeys
    wireHotkeys({ pane, controls, orb, displayMode, captureAnchor, saveCurrentSession });

    // debug handle for console inspection
    window.__viewer = { app, splat, camera, controls, orb, field, characters, sources, autoCam, minimap, sensorOverlay, displayMode, center, halfExtents, params, get navGrid() { return navGrid; } };

    // ---------------------------------------------------------- per-frame
    // auto-cutaway engages only when the camera is clearly OUTSIDE the room, so
    // moving around (or near a wall) inside never trips it. The box is inflated
    // by an engage margin that matches the shader's own outside-face test.
    const roomBox = new BoundingBox(
        center.clone(),
        halfExtents.clone().add(new Vec3(CUTAWAY_ENGAGE_MARGIN, CUTAWAY_ENGAGE_MARGIN, CUTAWAY_ENGAGE_MARGIN))
    );

    const round = (v, step) => Math.round(v / step) * step;

    // gsplat black-variant workaround: showing an avatar attaches a skinned mesh
    // to the World layer (for depth occlusion against the splats), which makes the
    // gsplat compile a broken shader variant that renders solid black. Recompiling
    // the gsplat material clears it, but only once the avatar's skinning has
    // settled — a recompile on the same frame is too early (the bad variant
    // doesn't exist yet). So when the first avatar becomes visible we recompile
    // across a frame window (to shorten the flash) plus two wall-clock-delayed
    // one-shots (the reliable net that lands after settle). The trigger is the
    // none→some *attached* transition, not the character-mode toggle: in sensor
    // mode a person may appear long after the mode is on. While every avatar is
    // hidden they are detached from all layers, so orb-only mode and startup stay
    // clean and need no kick (and dropping back to zero avatars returns the gsplat
    // to its known-good no-skin variant, so hiding needs no kick either).
    const CHAR_KICK_FRAMES = 30;
    const kickGsplat = () => {
        const gsMat = /** @type {any} */ (app.scene.gsplat)?.material;
        if (gsMat) { gsMat.clearVariants?.(); gsMat.update(); }
    };
    const scheduleGsplatKicks = () => {
        gsplatKickFrames = CHAR_KICK_FRAMES;
        setTimeout(kickGsplat, 600);
        setTimeout(kickGsplat, 1200);
    };
    let gsplatKickFrames = 0;
    let prevAnyAvatar = false;

    app.on('update', (dt) => {
        if (gsplatKickFrames > 0) {
            gsplatKickFrames--;
            kickGsplat();
        }
        sources.update(dt);
        field.update(dt, params.orb.smoothing);
        if (params.character.enabled) characters.update(dt, field, estFloor);
        const anyAvatar = params.character.enabled && characters.anyAttached();
        if (anyAvatar && !prevAnyAvatar) scheduleGsplatKicks();
        prevAnyAvatar = anyAvatar;
        helpBar.update();
        if (!displayMode.on) {
            sensorOverlay.update();
            navDebug.update();
        }

        // Auto Follow mode: drive the camera automatically (suspends the
        // manual CameraControls while active)
        if (params.camera.orbitOrb !== autoCam.active) {
            if (params.camera.orbitOrb) {
                autoCam.start();
            } else {
                autoCam.stop();
            }
        }
        autoCam.update(dt);

        const camPos = camera.getPosition();

        // cutaway state. While Auto Follow drives the camera we want a solid
        // interior view, so auto-cutaway is suppressed (it would peel the walls
        // and make the room look like a see-through box from outside).
        const outside = !roomBox.containsPoint(camPos);
        const cutOn = !autoCam.active && (
            params.cutaway.mode === 'on' ||
            (params.cutaway.mode === 'auto' && outside));

        // push shader uniforms (quantized; only re-renders splat when changed).
        // viewPos drives glow-facing only — coarsen it and freeze when unused so
        // camera motion doesn't trigger a gsplat resort every frame.
        // In character mode the avatar is the visual, so the orb glow is
        // suppressed entirely (no orbs, zero intensity, no glow-facing).
        const charMode = params.character.enabled;
        const glowFacingOn = !charMode && params.orb.glowIntensity > 0 && params.orb.glowFacing > 0;
        const orbStep = params.source.mode === 'click' ? 0.01 : 0.02;
        // one [x,y,z] per active orb, quantized so idle jitter doesn't resort
        const orbs = charMode ? [] : field.active().map((o) => {
            const p = o.getPosition();
            return [round(p.x, orbStep), round(p.y, orbStep), round(p.z, orbStep)];
        });
        splatFX.setParams({
            orbs,
            orbColor: [params.orb.color.r, params.orb.color.g, params.orb.color.b],
            orbIntensity: charMode ? 0 : params.orb.glowIntensity,
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
            glowFacing: charMode ? 0 : params.orb.glowFacing
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

/**
 * Build the floating "display mode" toggle. Display mode hides every on-screen
 * overlay (settings panel, minimap, help, in-scene sensor gizmo) for a clean
 * presentation/kiosk view. Returns an object whose `on` flag the update loop
 * reads to suppress the in-scene overlay (CSS handles the DOM chrome).
 */
function createDisplayToggle() {
    const startOn = typeof __KIOSK__ !== 'undefined' && __KIOSK__;
    const state = { on: startOn };
    const fab = document.createElement('button');
    fab.className = 'display-fab';
    fab.setAttribute('aria-label', 'Toggle display mode');
    fab.textContent = '🖥';
    const applyState = () => {
        document.body.classList.toggle('display-mode', state.on);
        fab.title = state.on
            ? 'Exit display mode — show controls (V)'
            : 'Display mode — hide controls (V)';
    };
    const toggle = () => {
        state.on = !state.on;
        applyState();
        // Leaving display mode re-reveals the settings panel, but its page-stack
        // height was last measured while `.cp` sat behind `display: none` (e.g.
        // the kiosk build boots straight into display mode) and got baked in as
        // 0px. The panel only re-measures on a window `resize`, so fire one here
        // — same trick buildSection() uses when expanding a collapsed section.
        window.dispatchEvent(new Event('resize'));
    };
    fab.addEventListener('click', toggle);
    document.body.appendChild(fab);
    applyState();
    return Object.assign(state, { element: fab, toggle });
}

/** Wire the global keyboard shortcuts. */
function wireHotkeys({ pane, controls, orb, displayMode, captureAnchor, saveCurrentSession }) {
    app.keyboard?.on(EVENT_KEYDOWN, (e) => {
        if (isTypingInPanel()) return;
        if (e.key === KEY_P) {
            pane.toggle();
        } else if (e.key === KEY_V) {
            displayMode.toggle();
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
