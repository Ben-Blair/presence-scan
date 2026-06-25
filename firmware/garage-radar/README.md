# garage-radar firmware

Custom ESP32 firmware that reads the **HLK-LD2450** mmWave radar over UART and
streams every tracked target to the PlayCanvas viewer over a WebSocket. It
replaces the old ESPHome setup (`esphome/garage-radar.yaml`), which only spoke
SSE, exposed just target #1, and needed the Node bridge to re-pair its X/Y.

## What it does

- Parses the raw 30-byte LD2450 frame (`AA FF 03 00` + 3×8-byte targets + `55 CC`)
  directly on the ESP — all 3 targets, at the sensor's native ~10 Hz, no dedup.
- Serves a WebSocket on `:81`. The viewer connects to `ws://garage-radar.local:81`
  and receives one packet per frame:

  ```json
  {"targets":[{"x":-820,"y":1740,"speed":-12}, {"x":410,"y":2300,"speed":0}]}
  ```

  X/Y are millimetres in sensor space (the viewer's `sensorToWorld` calibration
  maps them into the scan); `speed` is cm/s. Empty slots are omitted; an empty
  `{"targets":[]}` is sent when nobody is detected so the viewer clears its orbs.

## Hardware

ESP32-C3 devkit + HLK-LD2450 on UART: sensor TX → GPIO20 (ESP RX), sensor RX →
GPIO21 (ESP TX), 256000 baud, 5V power to the radar.

## Build & flash

Uses [PlatformIO](https://platformio.org/) (`pip install platformio` or the
VS Code extension).

```bash
cd firmware/garage-radar
cp src/secrets.h.example src/secrets.h   # fill in WiFi SSID/pass
pio run -t upload                        # USB the first time
pio device monitor                       # watch it connect + parse frames
```

After the first USB flash the device supports OTA. Uncomment the `upload_protocol`
/ `upload_port` lines in `platformio.ini`, then `pio run -t upload` flashes
wirelessly.

## Sanity check

With the device on the LAN, from a laptop:

```bash
websocat ws://garage-radar.local:81      # or connect in a browser console
```

Walk in front of the sensor — you should see `{"targets":[…]}` packets stream at
~10 Hz, with up to three targets when multiple people are present.
