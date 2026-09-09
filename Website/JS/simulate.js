/**
 * simulate.js
 * ===========
 * Hardware-free fake sensor transport. Implements the exact same
 * setSampleHandler / addSensor / disconnectSensor interface as ble.js, so
 * app.js never branches on real-vs-simulated beyond which object it holds
 * as state.transport. Lets the rest of the app (live view, processing,
 * recording, storage) be exercised and demoed without any Movesense
 * hardware nearby.
 *
 * Three scenarios, selectable via setScenario():
 *   "lift"     (default) — near-zero rotation, a repeating vertical accel
 *              pulse like a real rep: push, decelerate, rest.
 *   "rotation" — the bar spinning in place with no real translation.
 *              Accel and gyro here are built to be physically consistent
 *              with each other (the gyro reports the exact spin rate
 *              that's rotating the gravity vector in the accel channel) —
 *              this is what proves processing.js correctly rejects
 *              rotation instead of reporting it as fake velocity.
 *   "squat"    — a generic descend-then-ascend cycle (rest, descend,
 *              bottom pause, ascend, rest). The ascend half reuses the
 *              exact same pulse shape as "lift", so its concentric peak
 *              should match; the descend half is what proves reps.js
 *              correctly excludes downward motion instead of measuring it.
 *
 * Safe to delete later: remove this file plus the "simulate mode"
 * controls and their handlers in app.js/index.html.
 */

const MSSim = (() => {
  const TICK_MS = 50; // ~20 batches/sec, a few samples per batch, like real notifications
  const SAMPLE_RATE_HZ = 104;
  const GRAVITY = 9.80665;

  const ROTATION_RATE_DPS = 90; // constant spin about the sensor's local X axis
  const LIFT_CYCLE_S = 3.0; // total rep cycle: push + decel + rest
  const LIFT_PUSH_S = 0.6;
  const LIFT_DECEL_S = 0.6;
  const LIFT_PEAK_ACCEL = 3.0; // m/s^2, world-vertical

  const SQUAT_CYCLE_S = 5.0;
  const SQUAT_LEAD_REST_S = 0.6; // rest before descent (lets ZUPT arm at cycle start)
  const SQUAT_PULSE_S = LIFT_PUSH_S + LIFT_DECEL_S; // one push+decel unit, reused for descend/ascend
  const SQUAT_BOTTOM_PAUSE_S = 0.4; // pause between descend and ascend (re-arms ZUPT)

  let scenario = "lift";

  // label -> { timer, sampleIndex, phase, cycleStartT }
  const sensors = {};

  let sampleHandler = () => {};
  let statusHandler = () => {};

  function setSampleHandler(fn) {
    sampleHandler = fn;
  }

  function setStatusHandler(fn) {
    statusHandler = fn;
  }

  function setScenario(name) {
    scenario = name;
    // Reset every running sensor's phase so the new waveform starts cleanly
    // instead of picking up mid-cycle.
    for (const label of Object.keys(sensors)) {
      sensors[label].sampleIndex = 0;
      sensors[label].phase = Math.random() * Math.PI * 2;
    }
  }

  function noise(scale) {
    return (Math.random() - 0.5) * scale;
  }

  function rotationSample(t, phase) {
    // Noise levels here are meant to resemble real accelerometer/gyro
    // noise density, not to be artificially large — a sustained spin with
    // no rest moment is the hardest case for the velocity tracker (ZUPT
    // can't fire while gyro is nonzero), so inflating noise here would
    // overstate the drift a real recording would actually show.
    const angleRad = ((ROTATION_RATE_DPS * Math.PI) / 180) * t + phase;
    return {
      x: 0 + noise(0.05),
      y: GRAVITY * Math.sin(angleRad) + noise(0.05),
      z: GRAVITY * Math.cos(angleRad) + noise(0.05),
      gx: ROTATION_RATE_DPS + noise(0.5),
      gy: noise(0.5),
      gz: noise(0.5),
    };
  }

  // Half-sine push, half-sine decelerate, then rest — nets to ~zero
  // velocity change per cycle by construction.
  function liftPulseAt(tau) {
    if (tau < LIFT_PUSH_S) {
      return LIFT_PEAK_ACCEL * Math.sin((Math.PI * tau) / LIFT_PUSH_S);
    }
    if (tau < LIFT_PUSH_S + LIFT_DECEL_S) {
      const tt = tau - LIFT_PUSH_S;
      return -LIFT_PEAK_ACCEL * Math.sin((Math.PI * tt) / LIFT_DECEL_S);
    }
    return 0;
  }

  function liftSample(t) {
    const tau = t % LIFT_CYCLE_S;
    const pulse = liftPulseAt(tau);
    return {
      x: noise(0.05),
      y: noise(0.05),
      z: GRAVITY + pulse + noise(0.05),
      gx: noise(0.5),
      gy: noise(0.5),
      gz: noise(0.5),
    };
  }

  // rest -> descend (negated pulse) -> bottom pause -> ascend (same pulse
  // shape as liftSample) -> rest. Descend proves reps.js excludes downward
  // motion; ascend should reproduce liftSample's ~1.0 m/s peak.
  function squatSample(t) {
    const tau = t % SQUAT_CYCLE_S;
    let pulse = 0;

    if (tau >= SQUAT_LEAD_REST_S && tau < SQUAT_LEAD_REST_S + SQUAT_PULSE_S) {
      pulse = -liftPulseAt(tau - SQUAT_LEAD_REST_S);
    } else {
      const ascendStart = SQUAT_LEAD_REST_S + SQUAT_PULSE_S + SQUAT_BOTTOM_PAUSE_S;
      if (tau >= ascendStart && tau < ascendStart + SQUAT_PULSE_S) {
        pulse = liftPulseAt(tau - ascendStart);
      }
    }

    return {
      x: noise(0.05),
      y: noise(0.05),
      z: GRAVITY + pulse + noise(0.05),
      gx: noise(0.5),
      gy: noise(0.5),
      gz: noise(0.5),
    };
  }

  function tick(label) {
    const entry = sensors[label];
    if (!entry) return;

    const samplesPerTick = Math.round((SAMPLE_RATE_HZ * TICK_MS) / 1000);
    const recvAt = Date.now();

    for (let i = 0; i < samplesPerTick; i++) {
      entry.sampleIndex += 1;
      const t = entry.sampleIndex / SAMPLE_RATE_HZ;

      const values =
        scenario === "rotation"
          ? rotationSample(t, entry.phase)
          : scenario === "squat"
          ? squatSample(t)
          : liftSample(t);

      sampleHandler({
        sensor: label,
        device: `Simulated ${label}`,
        t,
        recvAt,
        x: values.x,
        y: values.y,
        z: values.z,
        gx: values.gx,
        gy: values.gy,
        gz: values.gz,
      });
    }
  }

  function addSensor(label) {
    statusHandler({ label, status: "connecting" });
    return new Promise((resolve) => {
      setTimeout(() => {
        sensors[label] = {
          sampleIndex: 0,
          phase: Math.random() * Math.PI * 2,
          timer: setInterval(() => tick(label), TICK_MS),
        };
        statusHandler({ label, status: "connected" });
        resolve({ label, deviceName: `Simulated ${label}` });
      }, 150); // tiny delay so "connecting…" is visible, like a real handshake
    });
  }

  function disconnectSensor(label) {
    const entry = sensors[label];
    if (!entry) return;
    clearInterval(entry.timer);
    delete sensors[label];
    statusHandler({ label, status: "disconnected" });
  }

  return {
    setSampleHandler,
    setStatusHandler,
    setScenario,
    addSensor,
    disconnectSensor,
  };
})();
