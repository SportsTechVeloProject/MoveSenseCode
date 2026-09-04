/**
 * ble.js
 * ======
 * Real Web Bluetooth transport for Movesense sensors. Connects directly
 * from the browser — no bridge, no backend. Web Bluetooth only allows one
 * device per requestDevice() call, so addSensor() is called once per
 * physical sensor (see app.js's two Connect Left/Right buttons).
 *
 * Protocol constants match the official Movesense sensordata-service GATT
 * protocol (same one movesense.html uses).
 *
 * Exposes a single global, MSBle, with the same three-method shape as
 * simulate.js so app.js can swap between them without branching.
 */

const MSBle = (() => {
  const SENSORDATA_SERVICE_UUID = "34802252-7185-4d5d-b431-630e7050e8f0";
  const COMMAND_CHAR_SUFFIX = "0001";
  const DATA_CHAR_SUFFIX = "0002";

  const CMD_SUBSCRIBE = 1;
  const CMD_UNSUBSCRIBE = 2;
  const RESP_COMMAND_RESULT = 1;
  const RESP_DATA = 2;
  const REF_ACC = 99;

  const RESOURCE_PATH = "/Meas/Acc";
  const SAMPLE_RATE_HZ = 104;

  // label -> { device, server, commandChar, dataChar, intentional }
  const devices = {};

  let sampleHandler = () => {};
  let statusHandler = () => {};

  function setSampleHandler(fn) {
    sampleHandler = fn;
  }

  function setStatusHandler(fn) {
    statusHandler = fn;
  }

  function handleNotification(label, deviceName, event) {
    const value = event.target.value; // DataView
    if (value.byteLength < 2) return;

    const response = value.getUint8(0);
    const reference = value.getUint8(1);

    if (response === RESP_COMMAND_RESULT) {
      return; // subscribe ack, nothing to do with it here
    }

    if (response === RESP_DATA && reference === REF_ACC) {
      const timestampMs = value.getUint32(2, true);
      const numSamples = (value.byteLength - 6) / 12;
      const recvAt = Date.now();

      for (let i = 0; i < numSamples; i++) {
        const x = value.getFloat32(6 + i * 12, true);
        const y = value.getFloat32(6 + i * 12 + 4, true);
        const z = value.getFloat32(6 + i * 12 + 8, true);
        const t = timestampMs / 1000.0 + i / SAMPLE_RATE_HZ;

        sampleHandler({ sensor: label, device: deviceName, t, recvAt, x, y, z });
      }
    }
  }

  async function connect(label) {
    const entry = devices[label];
    const device = entry.device;

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SENSORDATA_SERVICE_UUID);
    const characteristics = await service.getCharacteristics();

    let commandChar = null;
    let dataChar = null;
    for (const char of characteristics) {
      const suffix = char.uuid.slice(4, 8);
      if (suffix === COMMAND_CHAR_SUFFIX) commandChar = char;
      else if (suffix === DATA_CHAR_SUFFIX) dataChar = char;
    }
    if (!commandChar || !dataChar) {
      throw new Error(`[${label}] sensordata-service characteristics not found`);
    }

    entry.server = server;
    entry.commandChar = commandChar;
    entry.dataChar = dataChar;

    await dataChar.startNotifications();
    dataChar.addEventListener("characteristicvaluechanged", (event) =>
      handleNotification(label, device.name, event)
    );

    const resource = `${RESOURCE_PATH}/${SAMPLE_RATE_HZ}`;
    const subscribePayload = new Uint8Array([
      CMD_SUBSCRIBE,
      REF_ACC,
      ...new TextEncoder().encode(resource),
    ]);
    await commandChar.writeValue(subscribePayload);
  }

  function onDisconnected(label) {
    return async () => {
      const entry = devices[label];
      if (!entry) return;

      if (entry.intentional) {
        statusHandler({ label, status: "disconnected" });
        return;
      }

      statusHandler({ label, status: "reconnecting" });
      try {
        await connect(label);
        statusHandler({ label, status: "connected" });
      } catch (err) {
        statusHandler({ label, status: "error", message: String(err) });
      }
    };
  }

  async function addSensor(label) {
    statusHandler({ label, status: "connecting" });

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: ["Movesense"] }],
      optionalServices: [SENSORDATA_SERVICE_UUID],
    });

    devices[label] = { device, intentional: false };
    device.addEventListener("gattserverdisconnected", onDisconnected(label));

    try {
      await connect(label);
    } catch (err) {
      delete devices[label];
      statusHandler({ label, status: "error", message: String(err) });
      throw err;
    }

    statusHandler({ label, status: "connected" });
    return { label, deviceName: device.name };
  }

  function disconnectSensor(label) {
    const entry = devices[label];
    if (!entry) return;
    entry.intentional = true;
    if (entry.device.gatt.connected) {
      entry.device.gatt.disconnect();
    }
    delete devices[label];
  }

  return {
    setSampleHandler,
    setStatusHandler,
    addSensor,
    disconnectSensor,
  };
})();
