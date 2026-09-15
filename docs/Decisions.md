# 1. Use Movesense sensors instead of a custom IMU board

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** whole team

## Context

We need two IMUs on the barbell sampling fast enough to integrate for
velocity. We first tried building our own board around a bare IMU, which
meant handling the firmware, BLE stack, power and enclosure ourselves.
With a semester-length project, that work competes directly with the
analysis work that is actually the point of the project.

## Options

1. **Custom IMU board** — full control over sampling and packet format,
   but we spent two weeks on it without getting a stable BLE stream.
2. **Movesense** — off-the-shelf, documented API, gives accelerometer,
   gyroscope, magnetometer and multi-subscription out of the box.
   Less control over the internals, and we're bound to their sample rates.

## Decision

Use two Movesense units, one per bar sleeve.

## Consequences

- The sensor stops being a research problem; effort moves to the analysis.
- We are limited to Movesense's available sample rates — needs checking
  against the peak bar velocities we expect.
- Mounting becomes a real design task, since the units weren't made to be
  clamped to a rotating sleeve (#11).




# Platform decision: website vs. native app

## Context

Early on, the plan was a native app talking to the Movesense sensors
over Bluetooth (this is what the original architecture diagram's
`src/ble: Native BLE, replaces bridge + client` box assumed). Before
building that, we worked through whether a native app was actually the
right call, given:

- A 6-week deadline for the whole project, not just this piece.
- The one non-negotiable requirement: connecting to **two** Movesense
  sensors at once has to be smooth and reliable.
- No strong preference either way — "I would be happy with either a
  nice website or app" — so the decision was free to be driven by
  constraints rather than a prior commitment to one platform.
- Later layers (login, exercise picker, feedback) still had to be
  buildable on top of whatever we picked.

## Options considered

**Native mobile app (React Native)** — matches the original diagram's
intent most closely, and is the natural fit if the end product is
"open an app on your phone at the rack." Ruled out for now: needs a new
toolchain (Xcode/Android Studio, a BLE library, device provisioning)
with no existing experience on the team to draw on, which is a lot of
setup cost against a 6-week clock.

**Desktop app (Electron)** — full control over native BLE (e.g. via
`noble`), reasonable if a laptop stays at the rack during sessions.
Ruled out for the same reason as React Native: a new toolchain and BLE
library to learn, with nothing already built to build on.

**Website using the Web Bluetooth API directly** — the browser talks to
the sensors itself, no native toolchain at all. Chosen. We already had
working proof-of-concept code (`movesense.html`) that connected to
*multiple* Movesense sensors from the browser alone, proving the hard
part (dual-sensor BLE) was already solved in exactly this environment.

**(Website + local Python bridge)** — an earlier, now-abandoned
approach, in the repo's history as `movesense_bridge.py`. Ruled out
specifically because it requires a background process running on the
user's machine at all times — the opposite of "smooth," since it adds a
step (and a failure mode) before every session.

## Decision

**Website, using the Web Bluetooth API directly, no backend, no
background process.**

The deciding factors, in order:
1. **Existing working code.** `movesense.html` already proved dual-sensor
   Web Bluetooth connection worked — reusing that logic in
   `Website/JS/ble.js` meant starting from a solved problem, not a new
   one. Neither native option had anything equivalent to build on.
2. **Zero new toolchain.** No npm, no Xcode/Android Studio, no app store
   review — anyone on the team can open the site and start contributing
   immediately. This mattered directly against the 6-week deadline.
3. **"Smooth BLE" was achievable this way.** The one hard requirement
   (two sensors, reliably) didn't actually need a native BLE stack to
   satisfy — Web Bluetooth's `multi-subscription` pattern and
   `requestDevice()`-per-sensor flow, once implemented, held up under
   real hardware testing (see `BACKLOG.md`).

## Tradeoffs accepted

- **Chromium browsers only** — Web Bluetooth doesn't exist in Safari or
  Firefox, and not at all on iOS (even Chrome on iOS, since it's a
  Safari wrapper there). Practically: this only works on Chrome or Edge,
  desktop or Android.
- **A user gesture is required to pair each session** — no fully silent
  background reconnect across page loads; the user clicks "Connect" each
  time. Acceptable for a rack-side tool where someone is already
  physically present to start the sensors anyway.
- **No app-store presence** — can't be "installed" the way a native app
  can; it's a URL. For a course project and early product, this is a
  non-issue; would need revisiting for a polished consumer release.
- **Windows Bluetooth stack flakiness** — real-hardware testing surfaced
  a transient `NotSupportedError: GATT operation already in progress`
  on Windows; worked around with a per-sensor connect lock and retry
  (see `Website/JS/ble.js`), not eliminated at the OS level.

## When to revisit

This isn't a permanent architectural commitment — it was the right call
for a 6-week MVP built on top of already-working code. Reconsider a
native app if any of these become true:
- **iOS support becomes a real requirement** (a coach or athlete needs
  this on an iPhone) — Web Bluetooth cannot do this at all, full stop.
- **Web Bluetooth's reliability doesn't hold up** at a larger scale of
  real-world use than what's been tested so far.
- **The product needs to work with the browser closed** — background
  monitoring, notifications, or anything else a website fundamentally
  can't do.
- **App-store distribution/branding becomes a business requirement**
  for whatever this product becomes after the course.

If any of those trigger, the accumulated `Website/JS/` logic (protocol
parsing, orientation fusion, rep detection) is portable — it's plain
JS with no browser-only dependencies apart from `ble.js`/`storage.js`,
so a native rewrite would replace those two files, not the whole
pipeline.
