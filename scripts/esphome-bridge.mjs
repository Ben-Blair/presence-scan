// Bridges an ESPHome device's SSE sensor stream (/events) to a plain
// WebSocket the viewer's mmWave source can consume, since orb-sources.js
// only speaks raw WebSocket and ESPHome's web_server only speaks SSE.
//
// Usage: copy .env.example to .env, set ESPHOME_HOST, then `npm run bridge`
// (or `npm run dev` which starts vite + the bridge together).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!key || process.env[key] !== undefined) continue;
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        process.env[key] = val;
    }
}

const ESPHOME_HOST = process.env.ESPHOME_HOST || 'garage-radar.local';
const ESPHOME_URL = `http://${ESPHOME_HOST}/events`;
const PORT = Number(process.env.PORT) || 8081;

// Entity ids come from the ESPHome sensor names "Orb X" / "Orb Y", which
// ESPHome slugifies to these ids in the SSE state events.
const X_ID = 'sensor-orb_x';
const Y_ID = 'sensor-orb_y';

const wss = new WebSocketServer({ port: PORT });
console.log(`WebSocket bridge listening on ws://localhost:${PORT}`);

let lastX = null;
let lastY = null;
let flushTimer = null;

// Don't dial the ESPHome device until the viewer actually wants sensor data
// (it opens a WS connection when the "Connect" button in the sensor panel
// is pressed) - otherwise this spams ENOTFOUND/retry every 3s whenever the
// sensor is unplugged, even if nobody asked for it.
let sseStarted = false;
wss.on('connection', () => {
    if (sseStarted) return;
    sseStarted = true;
    run();
});

function broadcast(x, y) {
    const payload = JSON.stringify({ x, y });
    for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
    }
}

// Uses node:http rather than fetch()/undici: ESPHome's web_server sends
// chunked transfer-encoding that undici's stricter parser stalls on
// (curl and node:http both handle it fine).
function connectSse() {
    return new Promise((resolve, reject) => {
        console.log(`Connecting to ${ESPHOME_URL} ...`);
        const req = http.get(ESPHOME_URL, { headers: { Accept: 'text/event-stream' } }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`SSE connect failed: ${res.statusCode}`));
                res.resume();
                return;
            }
            console.log('Connected to ESPHome SSE stream.');

            let buffer = '';
            res.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let idx;
                while ((idx = buffer.indexOf('\r\n\r\n')) !== -1) {
                    const block = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 4);
                    handleBlock(block);
                }
            });
            res.on('end', () => reject(new Error('SSE stream ended')));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

function handleBlock(block) {
    const dataLine = block.split('\r\n').find((line) => line.startsWith('data: '));
    if (!dataLine) return;

    let msg;
    try {
        msg = JSON.parse(dataLine.slice('data: '.length));
    } catch {
        return;
    }

    if (msg.id === X_ID) lastX = msg.value;
    else if (msg.id === Y_ID) lastY = msg.value;
    else return;

    scheduleFlush();
}

// The LD2450 reports a target as a coordinate pair, but ESPHome exposes X and Y
// as two separate sensors and the SSE stream sends them as two separate events
// per detection cycle. Broadcasting on each event would emit an incoherent
// intermediate point — the freshly-updated axis paired with the *previous*
// value of the other — making the orb jump in an L (the "choppy" staircase)
// instead of a straight line, and doubling the message rate with garbage.
// Coalesce every axis update that lands within one frame into a single
// {x, y} broadcast so only complete, coherent pairs reach the viewer.
function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (typeof lastX === 'number' && typeof lastY === 'number') {
            broadcast(lastX, lastY);
        }
    }, 16);
}

async function run() {
    for (;;) {
        try {
            await connectSse();
        } catch (err) {
            console.error(err.message);
        }
        console.log('Retrying in 3s...');
        await new Promise((r) => setTimeout(r, 3000));
    }
}
