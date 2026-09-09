![Architecture: IMU sensors through Web Bluetooth, local storage, planned processing/backend/screens](docs/architecture.svg)

# MoveSense Barbell Velocity Tracker

Tracks barbell velocity using two Movesense IMU sensors (one on each end of
the bar) over Bluetooth. Built for the KTH Sports Technology HT26 course
project.

## Current status: proof of concept

`Website/` is a working proof of concept for the bottom half of the diagram
above. It runs entirely in the browser — connect two Movesense sensors,
watch live IMU data (including a gyro-fused vertical velocity readout that
rejects bar rotation instead of misreading it as movement), record a
session, export it as CSV. No backend, no server process, nothing to keep
running in the background.

**Not built yet**: exercise selection, a polished results/feedback view,
or accounts (login, coach/student roles). The velocity computation itself
is built but **unvalidated on real hardware** — see
[BACKLOG.md](BACKLOG.md) for what still needs checking before it's
trusted, and for the rest of the task breakdown.

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
| `JS/ble.js` | Real Web Bluetooth transport. Connects directly to Movesense sensors — GATT service discovery, subscribe/notify, parses raw accelerometer *and gyroscope* notifications (Gyro subscribed alongside Acc, tagged with a separate reference ID — Web Bluetooth's "multi-subscription" pattern). Handles auto-reconnect if a sensor drops. One `requestDevice()` call per sensor (a Web Bluetooth limitation — the browser can't multi-select), so there are two "Connect Left/Right Sensor" buttons rather than one. |
| `JS/simulate.js` | Fake sensor transport with the *same interface* as `ble.js` (`addSensor`/`disconnectSensor`/`setSampleHandler`), so the rest of the app can't tell the difference. Three selectable scenarios: a real-lift vertical pulse, a pure-rotation spin (no translation — proves `processing.js` rejects rotation), and a squat-like descend-then-ascend cycle (proves `reps.js` excludes the downward phase). |
| `JS/processing.js` | Turns raw accel+gyro samples into a world-frame vertical velocity estimate. Raw accelerometer alone can't tell "the bar moved" from "the bar rotated" (confirmed on real recordings — rotation keeps acceleration *magnitude* ~constant while individual axes swing). Fuses gyro+accel via a Madgwick IMU-only filter to track orientation, rotates acceleration into a fixed world frame before removing gravity, then integrates to velocity with drift correction (ZUPT + a slow velocity leak). **POC-grade — built and verified against simulated data only, not yet validated on real hardware or against a reference measurement.** |
| `JS/reps.js` | Turns that velocity signal into discrete rep events, measuring "top speed" only during the concentric (upward) phase — the downward phase, whether a controlled eccentric lower or a dropped bar, is excluded with no exercise-specific logic (both are just sustained negative velocity). Reports peak/mean/median velocity per rep. Also POC-grade, same caveats as `processing.js`. |
| `JS/storage.js` | IndexedDB layer — all local, no server. Two stores: `sessions` (one row per recording) and `samples` (one row per IMU reading: raw accel/gyro plus the computed vertical velocity, tagged by session and sensor). Also builds the CSV export string. |
| `JS/app.js` | UI state and orchestration. Funnels samples from whichever transport is active through a per-sensor `processing.js` tracker into the live view (readout + peak velocity), and (while recording) into a batched write buffer flushed to `storage.js` every 500ms. Owns no BLE/IndexedDB/fusion-math details itself — those stay in `ble.js`/`storage.js`/`processing.js`. |

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
- **Data shape**: a `sample` is always `{ sensor, device, t, x, y, z, gx, gy, gz }`
  (plus `recvAt` and `vVert` once persisted) regardless of whether it came
  from a real sensor or the simulator — anything consuming samples should
  rely on that shape, not on which transport produced them. `gx/gy/gz` can
  be `undefined` for the first few ms of a real connection (before the
  first Gyro notification arrives) — treat missing gyro as "assume zero
  rotation," not an error.
- No build tooling on purpose (no npm/bundler) — keep it plain
  HTML/CSS/JS unless a real need for one shows up; it keeps the barrier
  to contributing near zero.
