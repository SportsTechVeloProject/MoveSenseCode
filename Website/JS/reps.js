/**
 * reps.js
 * =======
 * Turns the velocity signal from processing.js into discrete rep events,
 * measuring "top speed" only during the concentric (upward) portion of a
 * lift. Deliberately generic across exercises — squat descent, bench
 * lowering, and dropping the bar are all just sustained negative vertical
 * velocity, so excluding all downward phases uniformly excludes every one
 * of them with no exercise-specific or drop-specific logic.
 *
 * Pure signal interpretation — no knowledge of quaternions, accel, or
 * gyro. Consumes the {t, isCalibrating, isResting, verticalVelocity}
 * shape a processing.js tracker already produces per sample.
 *
 * Thresholds below are starting points, not tuned against real lifts —
 * see BACKLOG.md.
 *
 * Exposes a single global, MSReps, with one factory:
 *   const detector = MSReps.createRepDetector();
 *   detector.reset();
 *   const rep = detector.addSample(trackerResult); // null, or a finalized rep record
 *   const live = detector.getLiveState();
 */

const MSReps = (() => {
  const ENTER_VELOCITY_MPS = 0.05;
  const EXIT_UP_VELOCITY_MPS = 0.02;
  const ENTER_DOWN_VELOCITY_MPS = -0.05;
  const EXIT_DOWN_VELOCITY_MPS = -0.02;
  const CONFIRM_SAMPLES = 5; // ~48ms @104Hz, consecutive samples required to ENTER a phase
  const MIN_REP_DURATION_S = 0.1;
  const MIN_REP_PEAK_MPS = 0.15;
  const LOOKBACK_SIZE = CONFIRM_SAMPLES;

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function createRepDetector() {
    let phase = "resting";
    let pendingPhase = null;
    let pendingCount = 0;
    let lookback = []; // last LOOKBACK_SIZE {t, v} samples, always maintained
    let repIndex = 0;
    let current = null; // { startT, endT, peak, sum, count, velocities[] } while ascending

    function reset() {
      phase = "resting";
      pendingPhase = null;
      pendingCount = 0;
      lookback = [];
      repIndex = 0;
      current = null;
    }

    function pushLookback(t, v) {
      lookback.push({ t, v });
      if (lookback.length > LOOKBACK_SIZE) lookback.shift();
    }

    function startAscendingFromLookback() {
      const seed = lookback.slice();
      current = {
        startT: seed[0].t,
        endT: seed[seed.length - 1].t,
        peak: Math.max(...seed.map((s) => s.v)),
        sum: seed.reduce((acc, s) => acc + s.v, 0),
        count: seed.length,
        velocities: seed.map((s) => s.v),
      };
    }

    function finalizeAscending() {
      const rec = current;
      current = null;
      if (!rec) return null;
      const duration = rec.endT - rec.startT;
      if (duration < MIN_REP_DURATION_S || rec.peak < MIN_REP_PEAK_MPS) return null;
      repIndex += 1;
      return {
        repIndex,
        startT: rec.startT,
        endT: rec.endT,
        duration,
        peakVelocity: rec.peak,
        meanVelocity: rec.sum / rec.count,
        medianVelocity: median(rec.velocities),
        sampleCount: rec.count,
      };
    }

    function clearPending() {
      pendingPhase = null;
      pendingCount = 0;
    }

    function addSample(result) {
      if (!result || result.isCalibrating) {
        reset();
        return null;
      }

      const { t, isResting, verticalVelocity: v } = result;
      pushLookback(t, v);

      if (isResting) {
        const finalized = phase === "ascending" ? finalizeAscending() : null;
        phase = "resting";
        clearPending();
        return finalized;
      }

      if (phase === "ascending") {
        if (v <= EXIT_UP_VELOCITY_MPS) {
          const finalized = finalizeAscending();
          phase = "resting";
          clearPending();
          return finalized;
        }
        current.endT = t;
        current.peak = Math.max(current.peak, v);
        current.sum += v;
        current.count += 1;
        current.velocities.push(v);
        return null;
      }

      if (phase === "descending") {
        if (v >= EXIT_DOWN_VELOCITY_MPS) {
          phase = "resting";
          clearPending();
        }
        return null;
      }

      // phase === "resting": look for CONFIRM_SAMPLES consecutive samples
      // past an enter threshold before committing to a new phase.
      let instant = null;
      if (v > ENTER_VELOCITY_MPS) instant = "ascending";
      else if (v < ENTER_DOWN_VELOCITY_MPS) instant = "descending";

      if (instant === null || instant !== pendingPhase) {
        pendingPhase = instant;
        pendingCount = instant === null ? 0 : 1;
      } else {
        pendingCount += 1;
      }

      if (instant !== null && pendingCount >= CONFIRM_SAMPLES) {
        phase = instant;
        clearPending();
        if (phase === "ascending") startAscendingFromLookback();
      }
      return null;
    }

    function getLiveState() {
      if (phase === "ascending" && current) {
        return {
          phase,
          peakSoFar: current.peak,
          elapsed: current.endT - current.startT,
          provisionalRepIndex: repIndex + 1,
        };
      }
      return { phase, peakSoFar: null, elapsed: null, provisionalRepIndex: null };
    }

    return { reset, addSample, getLiveState };
  }

  return { createRepDetector };
})();
