# Backlog

Grouped so people can pick up a section and work in parallel without
stepping on each other's files. See [README.md](README.md) for what each
file currently does.

## Done (proof of concept)
- [x] Connect to two Movesense sensors simultaneously via Web Bluetooth
- [x] Live X/Y/Z readout + trace per sensor
- [x] Record a session to local storage (IndexedDB), batched writes
- [x] Session history list, CSV export, delete
- [x] Hardware-free "simulate sensors" mode for dev/demo without hardware
- [x] Gyro-fused vertical velocity (`Website/JS/processing.js`) — rejects
      bar rotation instead of misreading it as acceleration (confirmed:
      raw accel alone can't tell "moved" from "rotated" — see real-data
      analysis in git history / conversation). Madgwick IMU orientation
      fusion + gravity removal + ZUPT + a slow velocity leak to bound
      drift during sustained rotation. **Needs the real-hardware
      verification below before this is trusted** — only validated so far
      via `simulate.js`'s three scenarios.
- [x] Concentric-only rep detection (`Website/JS/reps.js`) — measures
      "top speed" only during the upward phase of a lift, excluding the
      downward phase (descent or a dropped bar — both are just sustained
      negative velocity, no special-case logic needed for either) and
      noise. Peak/mean/median velocity per rep, live phase indicator,
      separate reps CSV export. Verified via the new `simulate.js`
      "squat" scenario: exactly one rep per descend-then-ascend cycle,
      zero reps from the descend half, zero phantom reps from pure noise
      or from the rotation-only scenario.

## Hardware / BLE (`Website/JS/ble.js`)
- [ ] **First real-hardware check for the new Gyro subscription**: the
      binary layout of a Gyro notification over this specific GATT
      protocol was *assumed* (same shape as Acc — timestamp + 3×float32),
      not independently verified byte-for-byte. Watch the console for
      "implausible gyro sample" warnings on first connect — if they fire
      constantly, the byte-offset/unit assumption is wrong and needs
      re-deriving from a raw hex dump of an actual notification.
- [ ] With a sensor sitting still, confirm the live "V" readout settles
      near 0 and stays there (exercises calibration + ZUPT on real noise
      for the first time — noise characteristics used in `simulate.js`
      are estimates, not measured from real hardware).
- [ ] Manually spin one sensor in place (no translation) and confirm "V"
      stays near-zero — the real-hardware equivalent of the "Rotation
      only" simulated scenario, and the most important real-world
      confirmation that the rotation fix actually works.
- [ ] Record one real lift and one deliberate spin with this code and use
      them as the new reference recordings (the old `session_1`/`session_5`
      predate Gyro capture and can't validate this pipeline).
- [ ] Test with both sensors in real training conditions (range, barbell
      movement, sensor knocks) — confirm no dropped notifications at 104Hz
- [ ] Handle low battery / sensor power-off mid-session gracefully (right
      now a drop triggers one silent reconnect attempt, no UI warning)
- [ ] Decide if 104Hz is the right sample rate for velocity accuracy, or
      if we need a higher rate (`ble.js` has it hardcoded — trivial to
      change once decided)
- [ ] Confirm behavior on Android Chrome (Web Bluetooth also works there,
      untested so far) — relevant if this ever needs to run on a tablet
      courtside instead of a laptop

## Data processing (`Website/JS/processing.js`)
Gyro-fused velocity is now built (see "Done" above), but every threshold
in it is a generic starting point, not tuned against real recordings:
- [ ] Tune ZUPT thresholds (`ZUPT_ACCEL_BAND`, `ZUPT_GYRO_MAX_DPS`,
      `ZUPT_MIN_SAMPLES`) against real lift recordings — in particular
      whether a real lift's grip-adjustment micro-rotation could falsely
      suppress a real rest moment, or vice versa
- [ ] Tune the velocity leak time constant (`VELOCITY_LEAK_TIME_CONSTANT_S`,
      currently 20s — raised from an initial 2s after testing showed a
      short leak doesn't just decay drift, it measurably distorts a real
      push-then-decel pulse: a leaky integrator doesn't exactly cancel an
      antisymmetric pulse, since the leak bleeds off some of the push-
      phase gain before the decel phase can cancel it, leaving a real
      residual velocity that briefly registered as a second, spurious rep
      in `reps.js` testing) — still needs real-hardware tuning to confirm
      20s is right, not just plausible on synthetic data
- [ ] Tune `reps.js`'s thresholds (`ENTER_VELOCITY_MPS`, exit thresholds,
      `CONFIRM_SAMPLES`, `MIN_REP_DURATION_S`, `MIN_REP_PEAK_MPS`) against
      real lift recordings — a very slow "grinding" concentric near a 1RM
      could sit close to `MIN_REP_PEAK_MPS` and risk being discarded, and
      real turnaround noise at the bottom of a squat or top of a press
      might need a wider deadband than synthetic data suggests
- [ ] Calibration/first-motion interaction: the tracker requires ~500ms
      of stillness at Start Recording to calibrate orientation — starting
      a lift's first rep before that window closes means the early part
      of that rep is missed (confirmed on synthetic data: a scenario with
      no lead-in rest lost its first rep to calibration truncation, one
      with a lead-in rest didn't). Worth a brief "hold still" prompt in
      the UI once real screens exist, so this isn't a silent gotcha.
- [ ] Validate the whole pipeline against a reference measurement (see
      "Data validity" below) — it's currently POC-grade, not accuracy-tested

## UI/UX — the "layers" (connect → login → exercise → feedback)
- [ ] Demote the current live-view panels to a collapsed/dev-only section
      once real screens exist — it was only ever meant for testing
- [ ] Exercise selection screen (squat / bench / deadlift / etc.) —
      storage schema needs an `exerciseType` field added to `sessions`
- [ ] Post-lift feedback screen — depends on the data processing work
      above being done first
- [ ] Results/history view that's actually friendly (the current session
      table is deliberately bare-bones, built to prove storage works, not
      to be the real UI)

## Accounts & backend
Coach/student accounts and cross-device syncing cannot be done with the
current IndexedDB-only setup (it's local to one browser). This needs a
real backend — **decision pending on which one** (Supabase vs. Firebase
vs. custom — see conversation with Claude for tradeoffs, leaning
Supabase for the SQL fit and speed of setup).
- [ ] Pick and set up the backend/auth provider
- [ ] Design the coach/student data model (who can see whose sessions)
- [ ] Login/signup screens
- [ ] Decide sync strategy: record locally to IndexedDB during a live
      session (responsive, works if BLE drops focus), then push the
      finalized session to the backend on Stop — vs. writing straight to
      the backend. Recommend the former for reliability.

## Data validity / research
- [ ] Compare our velocity output against a reference method (linear
      position transducer, video-based tracker, or similar) to validate
      accuracy — relevant repos/papers to be shared and added here
- [ ] Document sensor placement/mounting protocol so recordings are
      comparable across sessions and people

## Testing / QA
- [ ] Cross-browser check: Chrome and Edge on Windows/Mac at minimum
- [ ] Confirm graceful behavior when Web Bluetooth isn't available at all
      (should fall back to simulate mode automatically — already built,
      needs a real test on a non-Chromium browser)

## Docs / deployment
- [ ] Decide where this gets hosted for real use (GitHub Pages works fine
      for a static site like this, once there's no backend secret to hide
      — revisit once backend is chosen)
- [ ] Keep this backlog updated as items get picked up — convert to
      GitHub Issues if the team wants tracking/assignment instead of a
      flat file
