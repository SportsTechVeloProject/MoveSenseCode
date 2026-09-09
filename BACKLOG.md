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
      separate reps CSV export. Verified via `simulate.js`'s "squat"
      scenario: exactly one rep per descend-then-ascend cycle, zero reps
      from the descend half, zero phantom reps from pure noise or the
      rotation-only scenario.
- [x] **First real-hardware recording (3 squats) exposed and fixed a real
      bug**: ZUPT (rest detection) required both low accel-deviation AND
      low gyro before zeroing velocity, but a loaded, actively-held
      barbell wobbles far more than assumed even while translationally
      still (median gyro magnitude 15-17°/s, p90 100-180°/s at "rest" —
      higher than the 90°/s the "rotation" test scenario spins at, so no
      fixed gyro threshold could work). This let velocity get stuck
      elevated for seconds at a time, registering pathological
      multi-second "reps." Fixed by dropping gyro from the rest gate
      entirely (accel-magnitude-near-gravity alone is the reliable
      signal — confirmed via `scripts/replay-samples.html`, a new dev
      tool that replays a real exported CSV through fresh copies of
      `processing.js`/`reps.js` to check real recordings, not just
      synthetic scenarios) and adding a `MAX_PHASE_DURATION_S` backstop
      in `reps.js` regardless. Then tuned `ZUPT_MIN_SAMPLES` (8→32) and
      `MIN_REP_PEAK_MPS` (0.15→0.4) against that same real recording,
      landing on a config that gives 4 consistent, cross-sensor-matching
      reps (3 squats + un-racking the bar beforehand, itself a genuine
      upward movement) while still passing every synthetic scenario.
      **Still only validated against one recording, one lifter, one
      exercise** — see Data processing below.

## Hardware / BLE (`Website/JS/ble.js`)
- [x] **Gyro subscription binary layout confirmed working on real
      hardware** — a real recording (3 squats, both sensors) came back
      with sane, correctly-parsed gx/gy/gz values throughout, no
      "implausible gyro sample" console warnings. The timestamp+3×float32
      layout assumption was correct; no byte-offset/unit fix needed.
- [ ] Manually spin one sensor in place (no translation) and confirm "V"
      stays near-zero — the real-hardware equivalent of the "Rotation
      only" simulated scenario. Not yet done — the real recording so far
      only covers squats, not a deliberate pure-rotation test.
- [ ] Record more real lifts across different exercises/lifters and use
      them as additional reference recordings alongside the squat one —
      replay each through `scripts/replay-samples.html` to catch
      regressions before they ship (the old `session_1`/`session_5`
      predate Gyro capture and can't be used for this).
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

## Data processing (`Website/JS/processing.js`, `Website/JS/reps.js`)
Gyro-fused velocity + rep detection are built (see "Done" above) and have
now been tuned once against one real recording — every threshold is
still a starting point for more data, not a finished calibration:
- [ ] **Validate against more recordings**: current thresholds
      (`ZUPT_ACCEL_BAND=1.0`, `ZUPT_MIN_SAMPLES=32`, `MIN_REP_PEAK_MPS=0.4`)
      are tuned against exactly one recording — 3 squats, one lifter, one
      session. Use `scripts/replay-samples.html` on new recordings
      (different exercises, lifters, tempos) to check these still hold;
      a very slow "grinding" concentric near a 1RM in particular could sit
      close to `MIN_REP_PEAK_MPS` and risk being discarded.
- [ ] `ZUPT_MIN_SAMPLES=32` (~308ms) is a real tradeoff, not a free
      improvement: shorter values (~75ms) let real barbell noise trigger
      ZUPT mid-rep and fragment one rep into several, but a longer
      confirm window also means a *genuine* very brief pause (e.g. a fast
      touch-and-go rep with almost no pause at the bottom) might not
      register as "resting" at all — worth checking against a recording
      with intentionally minimal rest between reps.
- [ ] Tune the velocity leak time constant (`VELOCITY_LEAK_TIME_CONSTANT_S`,
      currently 20s — raised from an initial 2s after testing showed a
      short leak doesn't just decay drift, it measurably distorts a real
      push-then-decel pulse: a leaky integrator doesn't exactly cancel an
      antisymmetric pulse, since the leak bleeds off some of the push-
      phase gain before the decel phase can cancel it, leaving a real
      residual velocity that briefly registered as a second, spurious rep
      in `reps.js` testing) — still needs more real recordings to confirm
      20s is right, not just plausible on synthetic data
- [ ] Tune `reps.js`'s remaining thresholds (`ENTER_VELOCITY_MPS`, exit
      thresholds, `CONFIRM_SAMPLES`, `MIN_REP_DURATION_S`) against more
      real lift recordings — only `MIN_REP_PEAK_MPS` has been tuned
      against real data so far
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
