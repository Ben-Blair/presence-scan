import { Vec3, Ray, Plane, KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_SHIFT } from 'playcanvas';
import { isTypingInPanel } from './dom-utils.js';
import { DEG_TO_RAD, insetBoundsXZ, clampToRoomXZ } from './math-utils.js';

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

// Auto-reconnect backoff: the ESP / WiFi can blip, so a dropped socket retries
// with an exponentially growing delay (reset on a successful open).
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

/**
 * Parse a sensor WebSocket payload into an array of `{ x, y }` targets in mm.
 * Accepts the new `{ targets: [{x, y, speed}, …] }` shape (non-numeric entries
 * filtered) and the legacy single-target `{ x, y }`. Returns an array (possibly
 * empty, which means "no targets — clear the orbs") for a recognised packet, or
 * `null` for malformed JSON / an unrecognised shape (caller keeps the last frame).
 *
 * @param {string} data - raw JSON message text
 * @returns {{x:number, y:number}[] | null}
 */
export function parseTargets(data) {
    let parsed;
    try {
        parsed = JSON.parse(data);
    } catch {
        return null;
    }
    if (Array.isArray(parsed.targets)) {
        return parsed.targets
            .filter((t) => typeof t.x === 'number' && typeof t.y === 'number')
            .map((t) => ({ x: t.x, y: t.y }));
    }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return [{ x: parsed.x, y: parsed.y }];
    }
    return null;
}

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
        // reconnect state
        this._wantConnected = false;     // true while the user intends a connection
        this._reconnectTimer = null;
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._malformedCount = 0;        // diagnostics: packets we couldn't parse

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

    /** User-initiated connect: open the socket and keep it alive across drops. */
    connectSensor() {
        this._wantConnected = true;
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._openSocket();
    }

    /** User-initiated disconnect: stop retrying and tear down. */
    disconnectSensor() {
        this._wantConnected = false;
        this._clearReconnect();
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._closeSocket();
        // drop any extra orbs the sensor had spawned and clear the diagnostics
        this.lastTargets = [];
        this.field.collapseToPrimary();
        this._setStatus('disconnected');
    }

    _setStatus(status) {
        this.sensorStatus = status;
        this.onStatusChange?.();
    }

    _openSocket() {
        this._closeSocket();
        this._clearReconnect();
        try {
            this.socket = new WebSocket(this.params.source.sensor.url);
            this._setStatus('connecting…');
            this.socket.onopen = () => {
                this._reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
                this._setStatus('connected');
            };
            this.socket.onclose = () => this._onDrop();
            this.socket.onerror = () => this._onDrop();
            this.socket.onmessage = (msg) => {
                const raw = parseTargets(msg.data);
                if (raw === null) {
                    // malformed / unrecognised — keep the last frame, but track it so a
                    // persistently bad feed is diagnosable instead of silently dropped
                    this._malformedCount++;
                    if (this._malformedCount === 1 || this._malformedCount % 100 === 0) {
                        console.warn(`[sensor] ignored ${this._malformedCount} malformed packet(s)`);
                    }
                    return;
                }
                const now = performance.now();
                this.lastTargets = raw.map((t) => ({ x: t.x, y: t.y, t: now }));
                // clone: sensorToWorld returns a shared temp, reused each call
                this.field.setTargets(raw.map((t) => this.sensorToWorld(t.x, t.y).clone()));
            };
        } catch {
            // synchronous failure (e.g. a malformed URL) — report and retry
            this.socket = null;
            this._onDrop();
        }
    }

    /** A socket closed or errored: retry with backoff while the user still wants in. */
    _onDrop() {
        if (this.socket) {
            this.socket.onopen = this.socket.onclose = null;
            this.socket.onerror = this.socket.onmessage = null;
            this.socket = null;
        }
        if (!this._wantConnected) {
            this._setStatus('disconnected');
            return;
        }
        if (this._reconnectTimer) return; // a retry is already pending
        this._setStatus('reconnecting…');
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._openSocket();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    _closeSocket() {
        if (this.socket) {
            this.socket.onopen = this.socket.onclose = null;
            this.socket.onerror = this.socket.onmessage = null;
            this.socket.close();
            this.socket = null;
        }
    }

    _clearReconnect() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    /** Map sensor-space (mm, sensor at origin) to world space via calibration. */
    sensorToWorld(sx, sy) {
        const s = this.params.source.sensor;
        const syf = s.flipSensorY ? -sy : sy; // mirror lateral axis if calibrated so
        const rad = s.rotationDeg * DEG_TO_RAD;
        // A downward mount tilt means the sensor's forward axis is its slant range,
        // not horizontal ground distance. Project it onto the floor (X is the tilt
        // axis, so it stays true) — otherwise far targets read too far out.
        const tilt = (s.mountTilt || 0) * DEG_TO_RAD;
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
            const b = insetBoundsXZ(c, he, 0.15);
            const innerMinX = b.minX + (wp.xNeg ?? 0);
            const innerMaxX = b.maxX - (wp.xPos ?? 0);
            const innerMinZ = b.minZ + (wp.zNeg ?? 0);
            const innerMaxZ = b.maxZ - (wp.zPos ?? 0);
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

        clampToRoomXZ(tmpOrbPos, this.roomBounds.center, this.roomBounds.halfExtents, 0.15);

        orb.setTarget(tmpOrbPos);
    }
}
