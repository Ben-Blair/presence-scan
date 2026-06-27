import { Vec3, Ray, Plane, KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_SHIFT } from 'playcanvas';
import { isTypingInPanel } from './dom-utils.js';

const tmpRay = new Ray();
const tmpPlane = new Plane();
const tmpHit = new Vec3();
const tmpFar = new Vec3();
const tmpForward = new Vec3();
const tmpRight = new Vec3();
const tmpMove = new Vec3();
const tmpOrbPos = new Vec3();
const tmpSensorWorld = new Vec3();
const tmpPlaneOrigin = new Vec3();

/**
 * Decides where the orbs should be. Three sources:
 *  - 'click':  double-click the floor to place the (primary) orb
 *  - 'demo':   the orb wanders around the room on a lissajous path
 *  - 'sensor': positions stream in from an HLK mmwave sensor over WebSocket.
 *              The sensor packet carries up to three targets per frame
 *              ({ targets: [{x, y, speed}, …] }, mm), one orb each.
 */
export class OrbSources {
    /**
     * @param {*} app - pc app
     * @param {*} cameraEntity - camera entity
     * @param {import('./orb-field.js').OrbField} field - the orb field
     * @param {*} params - global params object
     * @param {*} roomBounds - { center: Vec3, halfExtents: Vec3 } world-space room bounds
     */
    constructor(app, cameraEntity, field, params, roomBounds) {
        this.app = app;
        this.camera = cameraEntity;
        this.field = field;
        this.params = params;
        this.roomBounds = roomBounds;
        this.demoTime = 0;
        this.socket = null;
        this.sensorStatus = 'disconnected';
        this.onStatusChange = null;
        // latest raw sensor readings [{x, y, t}, …] for the minimap/overlay views
        this.lastTargets = [];

        const canvas = app.graphicsDevice.canvas;
        canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    }

    /**
     * Cast a screen-space click through the camera onto a horizontal plane and
     * return the world-space hit (or null). Defaults to the floor (y = floorY).
     */
    pickFloorPoint(clientX, clientY, planeY = this.params.source.floorY) {
        const cam = this.camera.camera;
        const rect = this.app.graphicsDevice.canvas.getBoundingClientRect();
        cam.screenToWorld(clientX - rect.left, clientY - rect.top, cam.farClip, tmpFar);
        const origin = this.camera.getPosition();
        tmpRay.set(origin, tmpFar.sub(origin).normalize());
        tmpPlane.setFromPointNormal(tmpPlaneOrigin.set(0, planeY, 0), Vec3.UP);
        return tmpPlane.intersectsRay(tmpRay, tmpHit) ? tmpHit : null;
    }

    onDoubleClick(e) {
        if (this.params.source.mode !== 'click') return;
        // intersect with the orb travel plane (floor + orb height)
        const hit = this.pickFloorPoint(e.clientX, e.clientY,
            this.params.source.floorY + this.params.orb.height);
        if (hit) this.field.primary().setTarget(hit);
    }

    connectSensor() {
        this.disconnectSensor();
        const url = this.params.source.sensor.url;
        try {
            this.socket = new WebSocket(url);
            this.sensorStatus = 'connecting…';
            this.onStatusChange?.();
            this.socket.onopen = () => {
                this.sensorStatus = 'connected';
                this.onStatusChange?.();
            };
            this.socket.onclose = () => {
                this.sensorStatus = 'disconnected';
                this.onStatusChange?.();
            };
            this.socket.onerror = () => {
                this.sensorStatus = 'error';
                this.onStatusChange?.();
            };
            this.socket.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    // New shape: { targets: [{x, y, speed}, …] } (up to three).
                    // Legacy single-target { x, y } is accepted as one target.
                    let raw;
                    if (Array.isArray(data.targets)) {
                        raw = data.targets.filter(
                            t => typeof t.x === 'number' && typeof t.y === 'number');
                    } else if (typeof data.x === 'number' && typeof data.y === 'number') {
                        raw = [{ x: data.x, y: data.y }];
                    } else {
                        return;
                    }
                    const now = performance.now();
                    this.lastTargets = raw.map(t => ({ x: t.x, y: t.y, t: now }));
                    // clone: sensorToWorld returns a shared temp, reused each call
                    this.field.setTargets(
                        raw.map(t => this.sensorToWorld(t.x, t.y).clone()));
                } catch {
                    // ignore malformed messages
                }
            };
        } catch {
            this.sensorStatus = 'error';
        }
    }

    disconnectSensor() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        // drop any extra orbs the sensor had spawned and clear the diagnostics
        this.lastTargets = [];
        this.field.collapseToPrimary();
        this.sensorStatus = 'disconnected';
        this.onStatusChange?.();
    }

    /** Map sensor-space (mm, sensor at origin) to world space via calibration. */
    sensorToWorld(sx, sy) {
        const s = this.params.source.sensor;
        const syf = s.flipSensorY ? -sy : sy; // mirror lateral axis if calibrated so
        const rad = (s.rotationDeg * Math.PI) / 180;
        // A downward mount tilt means the sensor's forward axis is its slant range,
        // not horizontal ground distance. Project it onto the floor (X is the tilt
        // axis, so it stays true) — otherwise far targets read too far out.
        const tilt = ((s.mountTilt || 0) * Math.PI) / 180;
        const mx = sx * s.scale;
        const mz = syf * s.scale * Math.cos(tilt);
        const wx = s.originX + mx * Math.cos(rad) - mz * Math.sin(rad);
        const wz = s.originZ + mx * Math.sin(rad) + mz * Math.cos(rad);
        const wy = this.params.source.floorY + this.params.orb.height;
        return tmpSensorWorld.set(wx, wy, wz);
    }

    update(dt) {
        if (this.params.source.mode === 'demo') {
            this.field.collapseToPrimary();
            this.demoTime += dt * this.params.source.demoSpeed;
            const t = this.demoTime;
            const c = this.roomBounds.center;
            const he = this.roomBounds.halfExtents;
            const wp = this.params.cutaway.wallPeels;
            const margin = 0.15;
            const innerMinX = c.x - he.x + (wp.xNeg ?? 0) + margin;
            const innerMaxX = c.x + he.x - (wp.xPos ?? 0) - margin;
            const innerMinZ = c.z - he.z + (wp.zNeg ?? 0) + margin;
            const innerMaxZ = c.z + he.z - (wp.zPos ?? 0) - margin;
            const midX = (innerMinX + innerMaxX) * 0.5;
            const halfX = (innerMaxX - innerMinX) * 0.5;
            const midZ = (innerMinZ + innerMaxZ) * 0.5;
            const halfZ = (innerMaxZ - innerMinZ) * 0.5;
            const x = midX + Math.sin(t) * halfX;
            const z = midZ + Math.sin(t * 0.63 + 1.3) * halfZ;
            const y = this.params.source.floorY + this.params.orb.height;
            this.field.primary().setTarget(tmpOrbPos.set(x, y, z));
        } else if (this.params.source.mode === 'click') {
            this.field.collapseToPrimary();
            // keep the orb riding the travel plane even when no arrow key is
            // held, so height changes take effect immediately
            this.field.primary().target.y = this.params.source.floorY + this.params.orb.height;
            this.updateKeyboard(dt);
        }
    }

    /** Arrow keys move the orb on the floor plane, relative to the camera view. */
    updateKeyboard(dt) {
        if (isTypingInPanel()) return;
        const kb = this.app.keyboard;
        const dx = (kb.isPressed(KEY_RIGHT) ? 1 : 0) - (kb.isPressed(KEY_LEFT) ? 1 : 0);
        const dz = (kb.isPressed(KEY_UP) ? 1 : 0) - (kb.isPressed(KEY_DOWN) ? 1 : 0);
        if (dx === 0 && dz === 0) return;

        const speed = this.params.source.keyboardSpeed *
            (kb.isPressed(KEY_SHIFT) ? 2.5 : 1) * dt;

        this.camera.getWorldTransform().getZ(tmpForward);
        tmpForward.mulScalar(-1);
        tmpForward.y = 0;
        if (tmpForward.lengthSq() < 1e-6) return;
        tmpForward.normalize();

        tmpRight.cross(tmpForward, Vec3.UP).normalize();

        const orb = this.field.primary();
        tmpMove.set(0, 0, 0);
        if (dz !== 0) {
            tmpMove.x += tmpForward.x * dz * speed;
            tmpMove.z += tmpForward.z * dz * speed;
        }
        if (dx !== 0) {
            tmpMove.x += tmpRight.x * dx * speed;
            tmpMove.z += tmpRight.z * dx * speed;
        }

        tmpOrbPos.copy(orb.target).add(tmpMove);
        tmpOrbPos.y = this.params.source.floorY + this.params.orb.height;

        const { center, halfExtents } = this.roomBounds;
        const margin = 0.15;
        const minX = center.x - halfExtents.x + margin;
        const maxX = center.x + halfExtents.x - margin;
        const minZ = center.z - halfExtents.z + margin;
        const maxZ = center.z + halfExtents.z - margin;
        tmpOrbPos.x = Math.min(maxX, Math.max(minX, tmpOrbPos.x));
        tmpOrbPos.z = Math.min(maxZ, Math.max(minZ, tmpOrbPos.z));

        orb.setTarget(tmpOrbPos);
    }
}
