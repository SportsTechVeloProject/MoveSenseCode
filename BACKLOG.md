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

## Hardware / BLE (`Website/JS/ble.js`)
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

## Data processing — turning raw IMU data into a velocity/rep metric
This is the biggest open gap: right now we store raw x/y/z accelerometer
samples, nothing more. Needed before "feedback after doing the lift(s)"
means anything.
- [ ] Define the actual metric(s) we report (mean concentric velocity?
      peak velocity? bar path?) — needs research input, see "Data
      validity" below
- [ ] Integrate acceleration → velocity (numerical integration, drift
      correction — raw IMU integration drifts over time, will need either
      zero-velocity resets between reps or a filtering approach)
- [ ] Rep detection (segment a recording into individual reps)
- [ ] Decide where this computation runs (client-side JS in a new
      `Website/JS/processing.js`, matching the `src/processing` box in the
      original architecture diagram)

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
