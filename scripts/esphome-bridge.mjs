// Bridges an ESPHome device's SSE sensor stream (/events) to a plain
// WebSocket the viewer's mmWave source can consume, since orb-sources.js
// only speaks raw WebSocket and ESPHome's web_server only speaks SSE.
//
// Usage: ESPHOME_HOST=192.168.1.22 node scripts/esphome-bridge.mjs
import http from 'node:http';
import { WebSocketServer } from 'ws';

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

    if (typeof lastX === 'number' && typeof lastY === 'number') {
        broadcast(lastX, lastY);
    }
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
