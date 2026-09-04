![Architecture: IMU sensors through Web Bluetooth, local storage, planned processing/backend/screens](docs/architecture.svg)

# MoveSense Barbell Velocity Tracker

Tracks barbell velocity using two Movesense IMU sensors (one on each end of
the bar) over Bluetooth. Built for the KTH Sports Technology HT26 course
project.

## Current status: proof of concept

`Website/` is a working proof of concept for the bottom half of the diagram
above (`src/ble` → `src/storage`, roughly). It runs entirely in the
browser — connect two Movesense sensors, watch live IMU data, record a
session, export it as CSV. No backend, no server process, nothing to keep
running in the background.

**Not built yet**: exercise selection, velocity/feedback processing, a
polished results view, or accounts (login, coach/student roles). See
[BACKLOG.md](BACKLOG.md) for the task breakdown.

## Running it

Web Bluetooth requires a secure context (`https://` or `localhost`) and
only works in Chromium browsers — **Chrome or Edge**, not Safari or
Firefox. Opening the HTML file directly (`file://`) will not work.

```bash
python -m http.server 8090 --directory Website
```

Then open `http://localhost:8090` in Chrome or Edge.

There's also a **"Use simulated sensors"** checkbox on the page for
developing/demoing without any Movesense hardware nearby — it generates
fake but plausible accelerometer data through the exact same code path as
real sensors.

## Repo layout

### `Website/` — the actual product (this is what's being developed)

| File | Purpose |
|---|---|
| `index.html` | Entry point: markup, dark-theme styling, and the `<script>` tags that wire everything together. |
| `JS/ble.js` | Real Web Bluetooth transport. Connects directly to Movesense sensors — GATT service discovery, subscribe/notify, parses raw accelerometer notifications. Handles auto-reconnect if a sensor drops. One `requestDevice()` call per sensor (a Web Bluetooth limitation — the browser can't multi-select), so there are two "Connect Left/Right Sensor" buttons rather than one. |
| `JS/simulate.js` | Fake sensor transport with the *same interface* as `ble.js` (`addSensor`/`disconnectSensor`/`setSampleHandler`), so the rest of the app can't tell the difference. Used for the "simulate sensors" checkbox. |
| `JS/storage.js` | IndexedDB layer — all local, no server. Two stores: `sessions` (one row per recording) and `samples` (one row per IMU reading, tagged by session and sensor). Also builds the CSV export string. |
| `JS/app.js` | UI state and orchestration. Funnels samples from whichever transport is active into the live view, and (while recording) into a batched write buffer flushed to `storage.js` every 500ms. Owns no BLE or IndexedDB details itself — those stay in `ble.js`/`storage.js`. |

### Legacy / reference (not used by `Website/`, kept for reference)

| File | Purpose |
|---|---|
| `movesense_breytt.html` | Original single-file Web Bluetooth prototype (jQuery + Plotly). Proved the multi-sensor connection pattern that `Website/JS/ble.js` is built on. |
| `movesense_bridge.py` | Python BLE-to-WebSocket bridge for a single sensor — an earlier architecture where a local Python process relayed sensor data to the browser. Superseded by direct Web Bluetooth (no background process needed), kept as an optional dev/debug tool. |
| `movesense_brigeMulti.py` | Same idea as above, extended to multiple sensors. Also superseded, also kept for reference. |

## Architecture notes for the team

- **No backend yet.** Everything currently lives in the browser
  (IndexedDB), scoped to one device. This is intentional for the POC
  phase, but it means recorded sessions don't sync across devices or
  users — that requires a real backend + auth, which is planned but not
  started (see backlog).
- **Data shape**: a `sample` is always `{ sensor, device, t, x, y, z }`
  (plus `recvAt` once persisted) regardless of whether it came from a real
  sensor or the simulator — anything consuming samples should rely on
  that shape, not on which transport produced them.
- No build tooling on purpose (no npm/bundler) — keep it plain
  HTML/CSS/JS unless a real need for one shows up; it keeps the barrier
  to contributing near zero.
