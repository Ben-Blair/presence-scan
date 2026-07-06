import { Vec3, Ray, Plane, KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_SHIFT } from 'playcanvas';
import { isTypingInPanel } from './dom-utils.js';
import { DEG_TO_RAD, clampToRoomXZ } from './math-utils.js';
import { DemoWander } from './demo-wander.js';
import { OneEuroFilter1D } from './one-euro-filter.js';

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

const MAX_SENSOR_SLOTS = 3; // mirrors OrbField's MAX_ORBS — LD2450 tracks up to 3 targets
// A gap longer than this between packets means the derivative estimate can no
// longer be trusted (e.g. after a reconnect) — treat it like a fresh slot.
const MAX_FILTER_DT = 0.5;
// One Euro Filter's derivative-smoothing cutoff — fixed per the reference
// implementation, rarely worth exposing as a tunable.
const FILTER_D_CUTOFF = 1.0;

/**
 * Parse a sensor WebSocket payload into an array of `{ x, y }` targets in mm.
 * Accepts the `{ targets: [{x, y, speed}, …] }` shape (non-numeric entries
 * filtered). Returns an array (possibly empty, which means "no targets — clear
 * the orbs") for a recognised packet, or `null` for malformed JSON / an
 * unrecognised shape (caller keeps the last frame).
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
    return null;
}

/**
 * Decides where the orbs should be. Three sources:
 *  - 'click':  double-click the floor to place the (primary) orb
 *  - 'demo':   orbs wander the room on A* paths over the nav grid, avoiding
 *              obstacles and each other (see demo-wander.js)
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
     * @param {import('./nav-grid.js').NavGrid} navGrid - occupancy grid for demo-mode pathfinding
     */
    constructor(app, cameraEntity, field, params, roomBounds, navGrid) {
        this.app = app;
        this.camera = cameraEntity;
        this.field = field;
        this.params = params;
        this.roomBounds = roomBounds;
        this.demoWander = new DemoWander(navGrid, params, roomBounds);
        this._lastMode = null;
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
        // per-slot One Euro filters smoothing raw sensor-space {x,y} noise before
        // sensorToWorld() — orb i always tracks LD2450 slot i (see class doc)
        this._filters = Array.from({ length: MAX_SENSOR_SLOTS }, () => ({
            x: new OneEuroFilter1D(), y: new OneEuroFilter1D()
        }));
        this._slotActive = new Array(MAX_SENSOR_SLOTS).fill(false);
        this._lastSensorMsgTime = null;

        const canvas = app.graphicsDevice.canvas;
        canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    }

    /** Swap in a rebuilt nav grid (cell size / clearance retuned in the panel). */
    setNavGrid(navGrid) {
        this.demoWander.setGrid(navGrid);
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
        this._resetFilterState();
        this._setStatus('disconnected');
    }

    /** Forget per-slot filter history so the next packet starts every slot fresh. */
    _resetFilterState() {
        this._slotActive.fill(false);
        this._lastSensorMsgTime = null;
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
                const filtered = this._filterTargets(raw, now);
                // clone: sensorToWorld returns a shared temp, reused each call
                this.field.setTargets(filtered.map((t) => this.sensorToWorld(t.x, t.y).clone()));
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
        this._resetFilterState();
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

    /**
     * Smooth raw sensor-space targets through each slot's One Euro filter pair
     * before calibration. A slot resets (snaps, no lag) instead of filtering
     * whenever it just appeared or the gap since the last packet is too long
     * to trust the derivative estimate across — mirroring `OrbField`'s own
     * teleport-on-activation for a freshly (re)appearing target.
     *
     * @param {{x:number, y:number}[]} raw
     * @param {number} now - performance.now() at packet arrival
     * @returns {{x:number, y:number}[]}
     */
    _filterTargets(raw, now) {
        const s = this.params.source.sensor;
        const dt = this._lastSensorMsgTime === null ? null : (now - this._lastSensorMsgTime) / 1000;
        this._lastSensorMsgTime = now;

        if (!s.filterEnabled) {
            this._resetFilterState();
            return raw;
        }

        const minCutoff = s.filterMinCutoff;
        const beta = s.filterBeta;
        const filtered = raw.map((t, i) => {
            const f = this._filters[i];
            if (!f) return { x: t.x, y: t.y }; // beyond tracked slot count (firmware caps at 3)
            const canFilter = this._slotActive[i] && dt !== null && dt > 0 && dt <= MAX_FILTER_DT;
            if (canFilter) {
                return {
                    x: f.x.filter(t.x, dt, minCutoff, beta, FILTER_D_CUTOFF),
                    y: f.y.filter(t.y, dt, minCutoff, beta, FILTER_D_CUTOFF)
                };
            }
            f.x.reset(t.x);
            f.y.reset(t.y);
            return { x: t.x, y: t.y };
        });

        for (let i = 0; i < MAX_SENSOR_SLOTS; i++) this._slotActive[i] = i < raw.length;
        return filtered;
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
            // A* wander: on mode entry (re)spawn the orbs from wherever the
            // primary stands, then let the wander controller drive all of them
            if (this._lastMode !== 'demo') {
                this.demoWander.reset(this.field.primary().getPosition());
            }
            this.field.setTargets(this.demoWander.update(dt));
        } else if (this.params.source.mode === 'click') {
            this.field.collapseToPrimary();
            // keep the orb riding the travel plane even when no arrow key is
            // held, so height changes take effect immediately
            this.field.primary().target.y = this.params.source.floorY + this.params.orb.height;
            this.updateKeyboard(dt);
        }
        this._lastMode = this.params.source.mode;
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
