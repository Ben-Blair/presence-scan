// Garage mmWave radar -> WebSocket bridge, on the ESP32 itself.
//
// Pipeline (HumanRadar-style):
//   HLK-LD2450 --UART(256000 8N1)--> parse raw 30-byte frame
//     [AA FF 03 00][T1:8B][T2:8B][T3:8B][55 CC]
//   --WebSocket(:81)--> the PlayCanvas viewer (orb-sources.js)
//
// Each frame carries up to three targets at the sensor's full ~10 Hz. We
// broadcast one coherent JSON packet per frame:
//   {"targets":[{"x":<mm>,"y":<mm>,"speed":<cm/s>}, ...]}
// including only ACTIVE targets (a target with x==0 && y==0 means "no target").
// An empty {"targets":[]} is still sent so the viewer can clear stale orbs.
//
// This replaces the ESPHome firmware: ESPHome's web_server only spoke SSE,
// exposed just target_1's X/Y as two separate (deduped, throttled) sensors,
// and needed a Node bridge to re-pair them. Reading raw frames here gives all
// three targets, full rate, no dedup, and lets the viewer connect directly.

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebSocketsServer.h>
#include "secrets.h"

// LD2450 UART. Same pins/baud as the old garage-radar.yaml.
static const int      RADAR_RX_PIN = 20;  // ESP RX  <- sensor TX
static const int      RADAR_TX_PIN = 21;  // ESP TX  -> sensor RX
static const uint32_t RADAR_BAUD   = 256000;
#define RADAR_SERIAL Serial1

// LD2450 frame layout.
static const uint8_t  FRAME_HEAD[4] = { 0xAA, 0xFF, 0x03, 0x00 };
static const uint8_t  FRAME_TAIL[2] = { 0x55, 0xCC };
static const size_t   TARGET_LEN    = 8;   // bytes per target (x,y,speed,res)
static const size_t   FRAME_LEN     = 30;  // 4 head + 3*8 targets + 2 tail

// Reboot rather than hang forever if WiFi won't come up at boot.
static const uint32_t WIFI_TIMEOUT_MS = 20000;

WebSocketsServer webSocket(81);

// ---------------------------------------------------------------- LD2450 parse

// One coordinate/speed value: signed-magnitude, little-endian. Bit 15 is the
// sign flag (1 = positive). So +x = (raw & 0x7FFF), -x = -(raw & 0x7FFF).
static int16_t decodeSigned(uint8_t lo, uint8_t hi) {
    uint16_t raw = (uint16_t)lo | ((uint16_t)hi << 8);
    int16_t mag = raw & 0x7FFF;
    return (raw & 0x8000) ? mag : -mag;
}

// Build {"targets":[...]} from a 24-byte payload and broadcast it. Only targets
// with non-zero X/Y are included.
static void broadcastFrame(const uint8_t* payload) {
    char json[256];
    size_t n = 0;
    n += snprintf(json + n, sizeof(json) - n, "{\"targets\":[");

    bool first = true;
    for (int t = 0; t < 3; t++) {
        const uint8_t* b = payload + t * TARGET_LEN;
        int16_t x = decodeSigned(b[0], b[1]);
        int16_t y = decodeSigned(b[2], b[3]);
        int16_t speed = decodeSigned(b[4], b[5]);
        if (x == 0 && y == 0) continue;  // empty slot
        n += snprintf(json + n, sizeof(json) - n,
                      "%s{\"x\":%d,\"y\":%d,\"speed\":%d}",
                      first ? "" : ",", x, y, speed);
        first = false;
    }
    n += snprintf(json + n, sizeof(json) - n, "]}");
    webSocket.broadcastTXT((uint8_t*)json, n);
}

// Stream parser: slide a byte at a time until the 4-byte header lands, then
// collect the payload and verify the tail before broadcasting.
static void pumpRadar() {
    static uint8_t frame[FRAME_LEN];
    static size_t  have = 0;

    while (RADAR_SERIAL.available()) {
        uint8_t byte = RADAR_SERIAL.read();

        // Resync on the header bytes.
        if (have < 4) {
            if (byte == FRAME_HEAD[have]) {
                frame[have++] = byte;
            } else {
                // Restart, but allow this byte to be a fresh header[0].
                have = (byte == FRAME_HEAD[0]) ? 1 : 0;
                if (have) frame[0] = byte;
            }
            continue;
        }

        frame[have++] = byte;
        if (have == FRAME_LEN) {
            have = 0;
            if (frame[FRAME_LEN - 2] == FRAME_TAIL[0] && frame[FRAME_LEN - 1] == FRAME_TAIL[1]) {
                broadcastFrame(frame + 4);
            }
            // bad tail -> drop and resync on the next header
        }
    }
}

// ---------------------------------------------------------------- net plumbing

static void onWsEvent(uint8_t num, WStype_t type, uint8_t*, size_t) {
    if (type == WStype_CONNECTED) {
        Serial.printf("[ws] client %u connected\n", num);
    } else if (type == WStype_DISCONNECTED) {
        Serial.printf("[ws] client %u disconnected\n", num);
    }
}

static void connectWifi() {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);  // keep the radio awake so the feed streams smoothly
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[wifi] connecting");
    const uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        delay(250);
        Serial.print('.');
        if (millis() - start > WIFI_TIMEOUT_MS) {
            // AP down at boot — reboot and retry instead of hanging in setup()
            Serial.println("\n[wifi] timeout, restarting");
            ESP.restart();
        }
    }
    Serial.printf("\n[wifi] %s\n", WiFi.localIP().toString().c_str());
}

void setup() {
    Serial.begin(115200);
    RADAR_SERIAL.begin(RADAR_BAUD, SERIAL_8N1, RADAR_RX_PIN, RADAR_TX_PIN);

    connectWifi();

    if (MDNS.begin(DEVICE_HOSTNAME)) {
        Serial.printf("[mdns] %s.local\n", DEVICE_HOSTNAME);
    }

    ArduinoOTA.setHostname(DEVICE_HOSTNAME);
    ArduinoOTA.begin();

    webSocket.begin();
    webSocket.onEvent(onWsEvent);
    Serial.printf("[ws] listening on ws://%s.local:81\n", DEVICE_HOSTNAME);
}

void loop() {
    ArduinoOTA.handle();
    webSocket.loop();
    pumpRadar();
}
