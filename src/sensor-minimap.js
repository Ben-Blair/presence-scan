/**
 * Bottom-corner radar plot of the live mmWave stream — modeled on the readout
 * in the HLK-LD2450 phone app. It draws the sensor at top-center with a fan of
 * distance rings opening downward, and plots the current target (plus a short
 * fading trail) at its raw sensor coordinates. This is a diagnostic view: it
 * shows the sensor's own numbers so you can confirm it sees you and tracks
 * accurately, independent of how the orb is calibrated into the room.
 *
 * Self-contained: it owns a DOM canvas and its own requestAnimationFrame loop,
 * and only reads from the shared OrbSources (`lastTargets`, `sensorStatus`).
 */
import { clamp, DEG_TO_RAD, RAD_TO_DEG } from './math-utils.js';
import { HALF_FOV_DEG, MAX_RANGE_M, SAMPLE_STALE_MS, SLOT_HEX, SLOT_RGB } from './sensor-config.js';

export class SensorMinimap {
    /**
     * @param {import('./orb-sources.js').OrbSources} sources
     * @param {*} params - shared params (uses params.source.mode for visibility)
     */
    constructor(sources, params) {
        this.sources = sources;
        this.params = params;

        // LD2450: ~120° field of view, 6 m nominal range (see sensor-config.js).
        this.maxRangeM = MAX_RANGE_M;
        this.halfFovDeg = HALF_FOV_DEG;

        this.cssW = 240;
        this.cssH = 220;
        this.originY = 22;       // sensor sits this far below the top edge
        this.bottomPad = 30;     // room for the coordinate readout text
        this.R = this.cssH - this.originY - this.bottomPad; // pixels for maxRange

        this.trails = [];        // per-slot [{ px, py, t }] recent positions
        this.trailMs = 1100;
        this.lastSeen = [];      // per-slot sources.lastTargets[i].t last ingested
        // one colour per target slot (matches the up-to-three orbs)
        this.palette = SLOT_HEX;
        this.trailRGB = SLOT_RGB;
        this._raf = 0;
        this._running = false;

        this.el = document.createElement('div');
        this.el.className = 'radar-minimap';
        this.canvas = document.createElement('canvas');
        this.el.appendChild(this.canvas);

        const ctx = this.canvas.getContext('2d');
        if (!ctx) throw new Error('SensorMinimap: 2D canvas context unavailable');
        this.ctx = ctx;
        this._sizeCanvas();
    }

    _sizeCanvas() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = Math.round(this.cssW * dpr);
        this.canvas.height = Math.round(this.cssH * dpr);
        this.canvas.style.width = `${this.cssW}px`;
        this.canvas.style.height = `${this.cssH}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    mount() {
        document.body.appendChild(this.el);
        this.wake();
    }

    destroy() {
        this._stop();
        this.el.remove();
    }

    /** Start (or keep) the draw loop when the radar may become visible. */
    wake() {
        if (!this._running) {
            this._running = true;
            this._raf = requestAnimationFrame(() => this._frame());
        }
    }

    _stop() {
        this._running = false;
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = 0;
        }
    }

    _frame() {
        // Show while the sensor drives the orb, or any time the socket is live
        // (connecting/connected) so the radar appears the moment you Connect.
        const st = this.sources.sensorStatus;
        const visible = this.params.source.mode === 'sensor' ||
            st === 'connected' || st === 'connecting…' || st === 'reconnecting…';
        this.el.classList.toggle('radar-minimap--on', visible);
        if (!visible) {
            this._stop();
            return;
        }

        const now = performance.now();
        const samples = this.sources.lastTargets || [];

        // A fresh, non-zero sample means a tracked target; (0,0) = "no target".
        const targets = [];
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            if (s.x === 0 && s.y === 0) continue;
            if (now - s.t >= SAMPLE_STALE_MS) continue;
            const mx = s.x / 1000; // lateral metres (raw, +x = right)
            const my = s.y / 1000; // distance metres (forward)
            targets.push({
                mx, my, slot: i,
                dist: Math.hypot(mx, my),
                angle: Math.atan2(mx, my) * RAD_TO_DEG // 0 = straight ahead
            });
            if (!this.trails[i]) this.trails[i] = [];
            if (s.t !== this.lastSeen[i]) {
                this.lastSeen[i] = s.t;
                const p = this._toPixels(mx, my);
                this.trails[i].push({ px: p.x, py: p.y, t: now });
            }
        }
        // prune every slot's trail
        for (const tr of this.trails) {
            if (!tr) continue;
            while (tr.length && now - tr[0].t > this.trailMs) tr.shift();
        }

        this._draw(targets, now);

        if (this._running) {
            this._raf = requestAnimationFrame(() => this._frame());
        }
    }

    _toPixels(mx, my) {
        const ox = this.cssW / 2;
        const k = this.R / this.maxRangeM;
        return { x: ox + mx * k, y: this.originY + my * k };
    }

    _draw(targets, now) {
        const ctx = this.ctx;
        const W = this.cssW;
        const H = this.cssH;
        const ox = W / 2;
        const oy = this.originY;
        const R = this.R;
        const hRad = this.halfFovDeg * DEG_TO_RAD;
        const down = Math.PI / 2;

        ctx.clearRect(0, 0, W, H);

        // detection fan fill
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.arc(ox, oy, R, down - hRad, down + hRad);
        ctx.closePath();
        ctx.fillStyle = 'rgba(143, 208, 255, 0.05)';
        ctx.fill();

        // distance rings + labels
        ctx.lineWidth = 1;
        ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textBaseline = 'middle';
        for (let d = 1; d <= this.maxRangeM; d++) {
            const r = (d / this.maxRangeM) * R;
            ctx.beginPath();
            ctx.arc(ox, oy, r, down - hRad, down + hRad);
            ctx.strokeStyle = 'rgba(143, 208, 255, 0.14)';
            ctx.stroke();
            ctx.fillStyle = 'rgba(143, 208, 255, 0.4)';
            ctx.textAlign = 'left';
            ctx.fillText(`${d}m`, ox + 4, oy + r - 6);
        }

        // fan boundary lines + centre line
        ctx.strokeStyle = 'rgba(143, 208, 255, 0.22)';
        for (const a of [down - hRad, down + hRad]) {
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(ox + R * Math.cos(a), oy + R * Math.sin(a));
            ctx.stroke();
        }
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(143, 208, 255, 0.16)';
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox, oy + R);
        ctx.stroke();
        ctx.setLineDash([]);

        // sensor marker at the origin
        ctx.fillStyle = '#8fd0ff';
        ctx.beginPath();
        ctx.moveTo(ox - 5, oy - 4);
        ctx.lineTo(ox + 5, oy - 4);
        ctx.lineTo(ox, oy + 4);
        ctx.closePath();
        ctx.fill();

        // title + connection status
        const status = this.sources.sensorStatus;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(232, 232, 240, 0.85)';
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText('mmWave radar', 8, 11);
        ctx.textAlign = 'right';
        ctx.fillStyle = status === 'connected' ? '#5fe08a'
            : status === 'error' ? '#ff7b7b' : 'rgba(232, 232, 240, 0.5)';
        ctx.fillText(status, W - 8, 11);

        // per-slot target trails (older = fainter)
        for (let i = 0; i < this.trails.length; i++) {
            const tr = this.trails[i];
            if (!tr) continue;
            const [tr0, tg0, tb0] = this.trailRGB[i % this.trailRGB.length];
            for (const p of tr) {
                const age = (now - p.t) / this.trailMs;
                ctx.beginPath();
                ctx.arc(p.px, p.py, 2.5, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${tr0}, ${tg0}, ${tb0}, ${0.35 * (1 - age)})`;
                ctx.fill();
            }
        }

        // current targets (one dot each, colour-coded by slot)
        ctx.textAlign = 'center';
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        for (const target of targets) {
            const colour = this.palette[target.slot % this.palette.length];
            const [r, g, b] = this.trailRGB[target.slot % this.trailRGB.length];
            const p = this._toPixels(target.mx, target.my);
            // clamp the glyph inside the canvas if the target overruns the range
            const px = clamp(p.x, 8, W - 8);
            const py = clamp(p.y, oy, H - this.bottomPad);
            ctx.beginPath();
            ctx.arc(px, py, 9, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.18)`;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(px, py, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = colour;
            ctx.fill();
        }

        // numeric readout for the primary (first) target
        if (targets.length) {
            const target = targets[0];
            ctx.fillStyle = 'rgba(232, 232, 240, 0.92)';
            const sx = (target.mx >= 0 ? '+' : '') + target.mx.toFixed(2);
            const more = targets.length > 1 ? `   +${targets.length - 1}` : '';
            ctx.fillText(`x ${sx}m   y ${target.my.toFixed(2)}m${more}`, W / 2, H - 18);
            ctx.fillStyle = 'rgba(143, 208, 255, 0.85)';
            ctx.fillText(`${target.dist.toFixed(2)} m   ${target.angle >= 0 ? '+' : ''}${target.angle.toFixed(0)}°`, W / 2, H - 6);
        } else {
            ctx.fillStyle = 'rgba(232, 232, 240, 0.45)';
            const msg = status === 'connected' ? '— no target —' : 'sensor not connected';
            ctx.fillText(msg, W / 2, H - 12);
        }
    }
}
