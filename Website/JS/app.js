/**
 * app.js
 * ======
 * UI state and wiring. Funnels samples from either MSBle or MSSim through
 * one handleSample(), which updates the live view and, while recording,
 * feeds the storage batch buffer. This file owns no protocol or
 * IndexedDB details — those live in ble.js/simulate.js and storage.js.
 */

const MAX_TRACE_POINTS = 300;
const FLUSH_INTERVAL_MS = 500;

const state = {
  transport: null, // MSBle or MSSim, set in init()
  sensors: { left: null, right: null }, // label -> { deviceName } | null
  recording: {
    active: false,
    sessionId: null,
    buffer: [],
    repBuffer: [],
    flushTimer: null,
    startedAt: null,
    sampleCount: 0,
  },
};

const panels = {}; // sensor label -> { valX, valY, valZ, valV, valPeak, repPhaseEl, repPeakEl, repListEl, canvas, ctx, history, peak, reps }
const trackers = {}; // sensor label -> MSProcessing tracker instance
const repDetectors = {}; // sensor label -> MSReps detector instance

// --- Live panels (dark-theme readout + canvas trace) ---

function ensurePanel(label) {
  if (panels[label]) return panels[label];

  const wrapper = document.createElement("div");
  wrapper.className = "sensor-panel";
  wrapper.innerHTML = `
    <h2>${label}</h2>
    <div class="readout">
      <div class="cell"><div class="label">X</div><div class="value" data-x>—</div></div>
      <div class="cell"><div class="label">Y</div><div class="value" data-y>—</div></div>
      <div class="cell"><div class="label">Z</div><div class="value" data-z>—</div></div>
      <div class="cell"><div class="label">V (m/s)</div><div class="value" data-v>—</div></div>
    </div>
    <canvas width="720" height="140"></canvas>
    <div class="peak">Peak: <span data-peak>—</span> m/s</div>
    <div class="rep-status">Phase: <span data-rep-phase>—</span> <span data-rep-peak></span></div>
    <ol class="rep-list" data-rep-list></ol>
  `;
  document.getElementById("panels").appendChild(wrapper);

  const canvas = wrapper.querySelector("canvas");
  const panel = {
    valX: wrapper.querySelector("[data-x]"),
    valY: wrapper.querySelector("[data-y]"),
    valZ: wrapper.querySelector("[data-z]"),
    valV: wrapper.querySelector("[data-v]"),
    valPeak: wrapper.querySelector("[data-peak]"),
    repPhaseEl: wrapper.querySelector("[data-rep-phase]"),
    repPeakEl: wrapper.querySelector("[data-rep-peak]"),
    repListEl: wrapper.querySelector("[data-rep-list]"),
    canvas,
    ctx: canvas.getContext("2d"),
    history: [],
    peak: 0,
    reps: [],
  };
  panels[label] = panel;
  return panel;
}

function drawTrace(panel) {
  const { ctx, canvas, history } = panel;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (history.length < 2) return;

  const mid = canvas.height / 2;
  const scale = 8;
  const step = canvas.width / MAX_TRACE_POINTS;

  ctx.strokeStyle = "#5fd68a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  history.forEach((v, i) => {
    const x = i * step;
    const y = mid - v * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function handleSample(sample) {
  const panel = ensurePanel(sample.sensor);
  panel.valX.textContent = sample.x.toFixed(2);
  panel.valY.textContent = sample.y.toFixed(2);
  panel.valZ.textContent = sample.z.toFixed(2);

  panel.history.push(sample.x);
  if (panel.history.length > MAX_TRACE_POINTS) panel.history.shift();
  drawTrace(panel);

  const tracker = trackers[sample.sensor];
  const result = tracker ? tracker.addSample(sample) : null;

  if (result && result.isCalibrating) {
    panel.valV.textContent = "cal…";
  } else if (result) {
    panel.valV.textContent = result.verticalVelocity.toFixed(2);
    panel.peak = Math.max(panel.peak, Math.abs(result.verticalVelocity));
    panel.valPeak.textContent = panel.peak.toFixed(2);
  }

  const repDetector = repDetectors[sample.sensor];
  const repEvent = repDetector ? repDetector.addSample(result) : null;
  let live = null;

  if (repDetector) {
    live = repDetector.getLiveState();
    panel.repPhaseEl.textContent = live.phase;
    panel.repPeakEl.textContent = live.phase === "ascending" ? `(peak so far: ${live.peakSoFar.toFixed(2)} m/s)` : "";
  }

  if (repEvent) {
    panel.reps.push(repEvent);
    const li = document.createElement("li");
    li.textContent = `#${repEvent.repIndex}: peak ${repEvent.peakVelocity.toFixed(2)} m/s, mean ${repEvent.meanVelocity.toFixed(2)}, median ${repEvent.medianVelocity.toFixed(2)}`;
    panel.repListEl.appendChild(li);
    if (state.recording.active) {
      state.recording.repBuffer.push({ ...repEvent, sensor: sample.sensor });
    }
  }

  if (state.recording.active) {
    const stored =
      result && !result.isCalibrating
        ? {
            ...sample,
            vVert: result.verticalVelocity,
            phase: live ? live.phase : undefined,
            repIndex: live ? live.provisionalRepIndex : undefined,
          }
        : sample;
    state.recording.buffer.push(stored);
  }
}

// --- Sensor connect/disconnect ---

function setStatusText(label, text, isError) {
  const el = document.getElementById(`status-${label}`);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "var(--idle)" : "var(--dim)";
}

function handleTransportStatus({ label, status, message }) {
  const text = {
    connecting: "connecting…",
    connected: "connected",
    reconnecting: "reconnecting…",
    disconnected: "disconnected",
    error: `error: ${message || "unknown"}`,
  }[status] || status;
  setStatusText(label, text, status === "error");
}

async function onConnectClick(label) {
  const button = document.getElementById(`connect-${label}`);
  button.disabled = true;
  try {
    const result = await state.transport.addSensor(label);
    state.sensors[label] = result;
    trackers[label] = MSProcessing.createTracker();
    repDetectors[label] = MSReps.createRepDetector();
    button.textContent = `Disconnect (${label})`;
    button.dataset.connected = "true";
  } catch (err) {
    console.error(err);
  } finally {
    button.disabled = false;
    updateSimulateToggleAvailability();
  }
}

function onDisconnectClick(label) {
  state.transport.disconnectSensor(label);
  state.sensors[label] = null;
  delete trackers[label];
  delete repDetectors[label];
  const button = document.getElementById(`connect-${label}`);
  button.textContent = `Connect ${label[0].toUpperCase()}${label.slice(1)} Sensor`;
  button.dataset.connected = "false";
  updateSimulateToggleAvailability();
}

function onSensorButtonClick(label) {
  const button = document.getElementById(`connect-${label}`);
  if (button.dataset.connected === "true") {
    onDisconnectClick(label);
  } else {
    onConnectClick(label);
  }
}

// --- Simulate mode toggle ---

function anySensorConnected() {
  return Object.values(state.sensors).some((s) => s !== null);
}

function updateSimulateToggleAvailability() {
  const simToggle = document.getElementById("simulateToggle");
  if (!navigator.bluetooth) return; // forced on, stays disabled
  simToggle.disabled = anySensorConnected();
}

function onSimulateToggle(event) {
  state.transport = event.target.checked ? MSSim : MSBle;
  document.getElementById("simulateScenario").disabled = !event.target.checked;
}

// --- Recording ---

function connectedSensorLabels() {
  return Object.entries(state.sensors)
    .filter(([, v]) => v !== null)
    .map(([label]) => label);
}

function flush() {
  const batch = state.recording.buffer;
  state.recording.buffer = [];
  const repBatch = state.recording.repBuffer;
  state.recording.repBuffer = [];

  if (batch.length > 0) {
    state.recording.sampleCount += batch.length;
    MSStorage.putSamples(state.recording.sessionId, batch).catch((err) =>
      console.error("flush failed", err)
    );
    document.getElementById("recordingCount").textContent = state.recording.sampleCount;
  }

  if (repBatch.length > 0) {
    MSStorage.putReps(state.recording.sessionId, repBatch).catch((err) =>
      console.error("rep flush failed", err)
    );
  }
}

async function onStartRecording() {
  const labelInput = document.getElementById("sessionLabel");
  const sessionId = await MSStorage.createSession(labelInput.value, connectedSensorLabels());

  // Pressing Start Recording is the user's deliberate "bar is racked,
  // ready" signal — a more reliable moment to (re)calibrate orientation
  // than connect time, when the sensor may still be getting attached.
  for (const label of connectedSensorLabels()) {
    if (trackers[label]) trackers[label].reset();
    if (repDetectors[label]) repDetectors[label].reset();
    if (panels[label]) {
      panels[label].peak = 0;
      panels[label].valPeak.textContent = "—";
      panels[label].reps = [];
      panels[label].repListEl.innerHTML = "";
      panels[label].repPhaseEl.textContent = "—";
      panels[label].repPeakEl.textContent = "";
    }
  }

  state.recording.active = true;
  state.recording.sessionId = sessionId;
  state.recording.buffer = [];
  state.recording.repBuffer = [];
  state.recording.startedAt = Date.now();
  state.recording.sampleCount = 0;
  state.recording.flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  labelInput.disabled = true;
  document.getElementById("startRecording").hidden = true;
  document.getElementById("stopRecording").hidden = false;
  document.getElementById("recordingStatus").hidden = false;
}

async function onStopRecording() {
  clearInterval(state.recording.flushTimer);
  flush();
  await MSStorage.finalizeSession(state.recording.sessionId, state.recording.sampleCount);

  state.recording.active = false;
  state.recording.sessionId = null;

  document.getElementById("sessionLabel").disabled = false;
  document.getElementById("sessionLabel").value = defaultSessionLabel();
  document.getElementById("startRecording").hidden = false;
  document.getElementById("stopRecording").hidden = true;
  document.getElementById("recordingStatus").hidden = true;

  refreshSessionList();
}

function defaultSessionLabel() {
  const now = new Date();
  return `Session ${now.toLocaleString()}`;
}

// --- Session history ---

function formatDuration(ms) {
  if (!ms) return "—";
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

async function refreshSessionList() {
  const sessions = await MSStorage.listSessions();
  const tbody = document.getElementById("sessionRows");
  tbody.innerHTML = "";

  for (const session of sessions) {
    const tr = document.createElement("tr");
    const duration = session.endedAt ? session.endedAt - session.startedAt : null;
    tr.innerHTML = `
      <td>${session.label}</td>
      <td>${new Date(session.startedAt).toLocaleString()}</td>
      <td>${formatDuration(duration)}</td>
      <td>${session.sensorLabels.join(", ") || "—"}</td>
      <td>${session.sampleCount}</td>
      <td>
        <button data-action="export" data-id="${session.id}">Export CSV</button>
        <button data-action="export-reps" data-id="${session.id}">Export Reps CSV</button>
        <button data-action="delete" data-id="${session.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

async function onExportCsv(sessionId) {
  const csv = await MSStorage.exportSessionCsv(sessionId);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session_${sessionId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function onExportRepsCsv(sessionId) {
  const csv = await MSStorage.exportSessionRepsCsv(sessionId);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session_${sessionId}_reps.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function onDeleteSession(sessionId) {
  if (!confirm("Delete this session and all its recorded samples?")) return;
  await MSStorage.deleteSession(sessionId);
  refreshSessionList();
}

function onSessionTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const sessionId = Number(button.dataset.id);
  if (button.dataset.action === "export") onExportCsv(sessionId);
  else if (button.dataset.action === "export-reps") onExportRepsCsv(sessionId);
  else if (button.dataset.action === "delete") onDeleteSession(sessionId);
}

// --- Init ---

async function init() {
  await MSStorage.init();

  const bluetoothAvailable = !!navigator.bluetooth;
  state.transport = bluetoothAvailable ? MSBle : MSSim;

  MSBle.setSampleHandler(handleSample);
  MSBle.setStatusHandler(handleTransportStatus);
  MSSim.setSampleHandler(handleSample);
  MSSim.setStatusHandler(handleTransportStatus);

  document.getElementById("connect-left").addEventListener("click", () => onSensorButtonClick("left"));
  document.getElementById("connect-right").addEventListener("click", () => onSensorButtonClick("right"));

  const simToggle = document.getElementById("simulateToggle");
  const scenarioSelect = document.getElementById("simulateScenario");
  if (!bluetoothAvailable) {
    simToggle.checked = true;
    simToggle.disabled = true;
    scenarioSelect.disabled = false;
    document.getElementById("bleWarning").hidden = false;
    state.transport = MSSim;
  }
  simToggle.addEventListener("change", onSimulateToggle);
  scenarioSelect.addEventListener("change", (event) => MSSim.setScenario(event.target.value));

  document.getElementById("sessionLabel").value = defaultSessionLabel();
  document.getElementById("startRecording").addEventListener("click", onStartRecording);
  document.getElementById("stopRecording").addEventListener("click", onStopRecording);
  document.getElementById("sessionRows").addEventListener("click", onSessionTableClick);

  window.addEventListener("beforeunload", () => {
    if (state.recording.active) flush(); // best-effort only
  });

  refreshSessionList();
}

document.addEventListener("DOMContentLoaded", init);
