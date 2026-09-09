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
    flushTimer: null,
    startedAt: null,
    sampleCount: 0,
  },
};

const panels = {}; // sensor label -> { valX, valY, valZ, canvas, ctx, history }

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
    </div>
    <canvas width="720" height="140"></canvas>
  `;
  document.getElementById("panels").appendChild(wrapper);

  const canvas = wrapper.querySelector("canvas");
  const panel = {
    valX: wrapper.querySelector("[data-x]"),
    valY: wrapper.querySelector("[data-y]"),
    valZ: wrapper.querySelector("[data-z]"),
    canvas,
    ctx: canvas.getContext("2d"),
    history: [],
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

  if (state.recording.active) {
    state.recording.buffer.push(sample);
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
  if (batch.length === 0) return;
  state.recording.sampleCount += batch.length;
  MSStorage.putSamples(state.recording.sessionId, batch).catch((err) =>
    console.error("flush failed", err)
  );
  document.getElementById("recordingCount").textContent = state.recording.sampleCount;
}

async function onStartRecording() {
  const labelInput = document.getElementById("sessionLabel");
  const sessionId = await MSStorage.createSession(labelInput.value, connectedSensorLabels());

  state.recording.active = true;
  state.recording.sessionId = sessionId;
  state.recording.buffer = [];
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
  if (!bluetoothAvailable) {
    simToggle.checked = true;
    simToggle.disabled = true;
    document.getElementById("bleWarning").hidden = false;
    state.transport = MSSim;
  }
  simToggle.addEventListener("change", onSimulateToggle);

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
