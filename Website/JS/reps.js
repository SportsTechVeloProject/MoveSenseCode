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
  // 0.4, not 0.15: replaying a real recording (scripts/replay-samples.html)
  // showed a clear noise floor of small spurious peaks (0.15-0.3 m/s) sitting
  // well below the real reps' peaks (0.5-1.4 m/s) — 0.4 sits in the gap
  // between them. Still just a starting point tuned against one recording,
  // one lifter, one exercise — expect to revisit per BACKLOG.md.
  const MIN_REP_PEAK_MPS = 0.4;
  const LOOKBACK_SIZE = CONFIRM_SAMPLES;

  // Backstop against a phase getting stuck open (e.g. processing.js's
  // rest-detector failing to fire promptly during a real held-still-but-
  // wobbling moment) regardless of why — independent of getting ZUPT
  // thresholds exactly right. Real clean reps topped out at 0.66s in
  // testing; velocity-based-training literature treats >2-2.5s concentric
  // as failed/grinding, giving a ceiling with margin on both sides.
  const MAX_PHASE_DURATION_S = 2.5;

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
    let descendingStartT = null;

    function reset() {
      phase = "resting";
      pendingPhase = null;
      pendingCount = 0;
      lookback = [];
      repIndex = 0;
      current = null;
      descendingStartT = null;
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

    function finalizeAscending(truncated) {
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
        truncated: !!truncated,
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
        const finalized = phase === "ascending" ? finalizeAscending(false) : null;
        phase = "resting";
        clearPending();
        return finalized;
      }

      if (phase === "ascending") {
        if (v <= EXIT_UP_VELOCITY_MPS) {
          const finalized = finalizeAscending(false);
          phase = "resting";
          clearPending();
          return finalized;
        }
        if (t - current.startT > MAX_PHASE_DURATION_S) {
          const finalized = finalizeAscending(true);
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
        if (v >= EXIT_DOWN_VELOCITY_MPS || t - descendingStartT > MAX_PHASE_DURATION_S) {
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
        if (phase === "descending") descendingStartT = lookback[0].t;
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
