/**
 * simulate.js
 * ===========
 * Hardware-free fake sensor transport. Implements the exact same
 * setSampleHandler / addSensor / disconnectSensor interface as ble.js, so
 * app.js never branches on real-vs-simulated beyond which object it holds
 * as state.transport. Lets the rest of the app (live view, recording,
 * storage) be exercised and demoed without any Movesense hardware nearby.
 *
 * Safe to delete later: remove this file plus the one "simulate mode"
 * checkbox and its handler in app.js/index.html.
 */

const MSSim = (() => {
  const TICK_MS = 50; // ~20 batches/sec, a few samples per batch, like real notifications
  const SAMPLE_RATE_HZ = 104;

  // label -> { timer, sampleIndex, phase }
  const sensors = {};

  let sampleHandler = () => {};
  let statusHandler = () => {};

  function setSampleHandler(fn) {
    sampleHandler = fn;
  }

  function setStatusHandler(fn) {
    statusHandler = fn;
  }

  function tick(label) {
    const entry = sensors[label];
    if (!entry) return;

    const samplesPerTick = Math.round((SAMPLE_RATE_HZ * TICK_MS) / 1000);
    const recvAt = Date.now();

    for (let i = 0; i < samplesPerTick; i++) {
      entry.sampleIndex += 1;
      const t = entry.sampleIndex / SAMPLE_RATE_HZ;

      // Roughly: gravity on z, a slow sinusoidal wobble, plus noise —
      // just enough motion to make the live traces look alive.
      const wobble = Math.sin(t * 1.3 + entry.phase) * 1.5;
      const noise = () => (Math.random() - 0.5) * 0.3;

      sampleHandler({
        sensor: label,
        device: `Simulated ${label}`,
        t,
        recvAt,
        x: wobble + noise(),
        y: noise(),
        z: 9.8 + noise(),
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
    addSensor,
    disconnectSensor,
  };
})();
