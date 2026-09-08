/**
 * processing.js
 * =============
 * Turns raw {accel, gyro} samples into a world-frame velocity estimate
 * that's robust to the bar rotating (grip slip, uneven load, knurling
 * wear). Raw accelerometer alone can't tell "the bar moved" apart from
 * "the bar rotated" — gravity's projection onto the sensor's own axes
 * changes as it rotates, which naive per-axis integration mistakes for
 * real acceleration. Confirmed on real recordings: a rotating-only bar
 * has accel *magnitude* ~constant (~9.8) while x/y/z swing wildly; a real
 * lift has magnitude itself swinging.
 *
 * Fix: fuse gyroscope + accelerometer into an orientation estimate
 * (Madgwick's IMU-only filter — no magnetometer, deliberately: barbell
 * plates are steel and would distort one, and lifts are short enough
 * that yaw drift without it is negligible — this is what commercial
 * barbell-velocity trackers do too), rotate each accel sample into a
 * fixed world frame, subtract gravity there instead of in sensor frame,
 * and integrate. Zero-Velocity Update (ZUPT) corrects the inevitable
 * integration drift by snapping velocity to zero whenever the sensor is
 * detected at rest.
 *
 * POC-grade metric — not validated against a reference velocity
 * measurement (linear position transducer, video tracking, etc.). See
 * BACKLOG.md "Data validity / research".
 *
 * Exposes a single global, MSProcessing, with one factory:
 *   const tracker = MSProcessing.createTracker();
 *   tracker.reset();
 *   const result = tracker.addSample({ t, x, y, z, gx, gy, gz });
 */

const MSProcessing = (() => {
  const CALIBRATION_MS = 500; // hold still this long after reset()
  const MADGWICK_BETA = 0.1; // standard IMU-only starting gain
  const GRAVITY = 9.80665;
  const ACCEL_REJECT_BAND = 3.0; // m/s^2 — beyond this, skip accel correction
  const ZUPT_ACCEL_BAND = 0.3; // m/s^2 around GRAVITY
  const ZUPT_GYRO_MAX_DPS = 5; // deg/s
  const ZUPT_MIN_SAMPLES = 8; // ~75ms @104Hz
  const MAX_DT_S = 0.25; // gap bigger than this (e.g. reconnect) -> reset

  // ZUPT can only fire when the sensor is genuinely still (low gyro too) —
  // it CANNOT catch drift while the bar is rotating but not translating,
  // since gyro is nonzero by definition the whole time. Sensor noise still
  // integrates into velocity during a sustained spin with no rest moment.
  // A slow velocity leak (exponential decay toward zero) bounds that drift
  // without materially affecting a real ~1s lift pulse — the time constant
  // is long compared to one rep, short compared to a multi-second spin.
  const VELOCITY_LEAK_TIME_CONSTANT_S = 2.0;

  const DEG2RAD = Math.PI / 180;

  function quatMultiply(a, b) {
    const [aw, ax, ay, az] = a;
    const [bw, bx, by, bz] = b;
    return [
      aw * bw - ax * bx - ay * by - az * bz,
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
    ];
  }

  function quatConjugate(q) {
    return [q[0], -q[1], -q[2], -q[3]];
  }

  function quatNormalize(q) {
    const norm = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (norm === 0) return [1, 0, 0, 0];
    return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
  }

  function vecNormalize(v) {
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (norm === 0) return [0, 0, 0];
    return [v[0] / norm, v[1] / norm, v[2] / norm];
  }

  function vecCross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function vecDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  // Rotates vector v (body/sensor frame) into world frame using q.
  function rotateVectorByQuat(q, v) {
    const vQuat = [0, v[0], v[1], v[2]];
    const result = quatMultiply(quatMultiply(q, vQuat), quatConjugate(q));
    return [result[1], result[2], result[3]];
  }

  // Shortest-arc rotation taking `from` (normalized) to `to` (normalized).
  function quatFromVectorAlignment(from, to) {
    const dot = vecDot(from, to);
    const axis = vecCross(from, to);
    if (dot < -0.999999) {
      // ~180 degrees apart — pick any axis perpendicular to `from`.
      let perp = vecCross([1, 0, 0], from);
      if (Math.sqrt(vecDot(perp, perp)) < 1e-6) {
        perp = vecCross([0, 1, 0], from);
      }
      perp = vecNormalize(perp);
      return [0, perp[0], perp[1], perp[2]]; // 180 degree rotation
    }
    const w = 1 + dot;
    return quatNormalize([w, axis[0], axis[1], axis[2]]);
  }

  function createTracker() {
    let calibrating = true;
    let calibrationSamples = [];
    let calibrationStartT = null;

    let q = [1, 0, 0, 0];
    let v = [0, 0, 0];
    let lastT = null;
    let restCount = 0;

    function reset() {
      calibrating = true;
      calibrationSamples = [];
      calibrationStartT = null;
      q = [1, 0, 0, 0];
      v = [0, 0, 0];
      lastT = null;
      restCount = 0;
    }

    function finishCalibration() {
      const avg = calibrationSamples.reduce(
        (acc, s) => [acc[0] + s[0], acc[1] + s[1], acc[2] + s[2]],
        [0, 0, 0]
      );
      const n = calibrationSamples.length;
      const upSensor = vecNormalize([avg[0] / n, avg[1] / n, avg[2] / n]);
      q = quatFromVectorAlignment(upSensor, [0, 0, 1]);
      calibrating = false;
      calibrationSamples = [];
    }

    function madgwickUpdate(ax, ay, az, gxRad, gyRad, gzRad, dt) {
      const qDotOmega = quatMultiply(q, [0, gxRad, gyRad, gzRad]).map((c) => 0.5 * c);

      const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
      const applyCorrection = Math.abs(accelMag - GRAVITY) <= ACCEL_REJECT_BAND && accelMag > 0;

      let qDot = qDotOmega;
      if (applyCorrection) {
        const [an, bn, cn] = vecNormalize([ax, ay, az]);
        const [q0, q1, q2, q3] = q;

        const f = [
          2 * (q1 * q3 - q0 * q2) - an,
          2 * (q0 * q1 + q2 * q3) - bn,
          2 * (0.5 - q1 * q1 - q2 * q2) - cn,
        ];

        // J^T * f (Jacobian transpose times objective function)
        const gradient = [
          -2 * q2 * f[0] + 2 * q1 * f[1],
          2 * q3 * f[0] + 2 * q0 * f[1] - 4 * q1 * f[2],
          -2 * q0 * f[0] + 2 * q3 * f[1] - 4 * q2 * f[2],
          2 * q1 * f[0] + 2 * q2 * f[1],
        ];
        const normalizedGradient = quatNormalize(gradient);

        qDot = qDotOmega.map((c, i) => c - MADGWICK_BETA * normalizedGradient[i]);
      }

      q = quatNormalize(q.map((c, i) => c + qDot[i] * dt));
    }

    function addSample(sample) {
      const { t, x, y, z } = sample;
      const gx = sample.gx || 0;
      const gy = sample.gy || 0;
      const gz = sample.gz || 0;

      if (calibrating) {
        if (calibrationStartT === null) calibrationStartT = t;
        calibrationSamples.push([x, y, z]);
        if ((t - calibrationStartT) * 1000 >= CALIBRATION_MS) {
          finishCalibration();
          lastT = t;
        }
        return { t, isCalibrating: true };
      }

      const dt = lastT === null ? null : t - lastT;
      lastT = t;

      if (dt === null || dt <= 0 || dt > MAX_DT_S) {
        reset();
        // Feed this sample into the fresh calibration window rather than
        // dropping it silently.
        calibrationStartT = t;
        calibrationSamples.push([x, y, z]);
        return { t, isCalibrating: true };
      }

      madgwickUpdate(x, y, z, gx * DEG2RAD, gy * DEG2RAD, gz * DEG2RAD, dt);

      const worldAccel = rotateVectorByQuat(q, [x, y, z]);
      const linAccel = [worldAccel[0], worldAccel[1], worldAccel[2] - GRAVITY];

      const leak = Math.exp(-dt / VELOCITY_LEAK_TIME_CONSTANT_S);
      v = [
        (v[0] + linAccel[0] * dt) * leak,
        (v[1] + linAccel[1] * dt) * leak,
        (v[2] + linAccel[2] * dt) * leak,
      ];

      const accelMag = Math.sqrt(x * x + y * y + z * z);
      const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
      const atRestNow = Math.abs(accelMag - GRAVITY) < ZUPT_ACCEL_BAND && gyroMag < ZUPT_GYRO_MAX_DPS;
      if (atRestNow) {
        restCount += 1;
        if (restCount === ZUPT_MIN_SAMPLES) {
          v = [0, 0, 0];
        }
      } else {
        restCount = 0;
      }

      return {
        t,
        isCalibrating: false,
        isResting: restCount >= ZUPT_MIN_SAMPLES,
        vx: v[0],
        vy: v[1],
        vz: v[2],
        verticalVelocity: v[2],
        speed: Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]),
        quaternion: q,
      };
    }

    return { reset, addSample };
  }

  return { createTracker };
})();
