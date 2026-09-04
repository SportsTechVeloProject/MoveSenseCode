"""
Movesense BLE Bridge — Multi-Sensor
=====================================
Connects to MULTIPLE Movesense sensors over BLE simultaneously (e.g. one on
each end of a barbell), each with independent automatic reconnection and
exponential backoff. All sensors' samples are re-broadcast to any connected
browser clients over a single local WebSocket server, tagged by "sensor"
label so your website can tell them apart (e.g. for left/right asymmetry).

Install:
    pip install bleak websockets

Run:
    python movesense_bridge.py

In your website's JS:
    const ws = new WebSocket("ws://localhost:8765");
    ws.onmessage = (event) => {
        const sample = JSON.parse(event.data);
        // sample = {sensor: "left", device: "...", t, x, y, z}
        if (sample.sensor === "left") { ... } else { ... }
    };
"""

import asyncio
import json
import logging
import struct
from typing import Dict, Optional, Set

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("movesense_bridge")

# --- Movesense GATT SensorData Protocol constants ---
SENSORDATA_SERVICE_UUID = "34802252-7185-4d5d-b431-630e7050e8f0"
COMMAND_CHAR_SUFFIX = "0001"
DATA_CHAR_SUFFIX = "0002"

CMD_SUBSCRIBE = 1
RESP_COMMAND_RESULT = 1
RESP_DATA = 2
REF_ACC = 99

RESOURCE_PATH = "/Meas/Acc"
SAMPLE_RATE_HZ = 104

DEVICE_NAME_PREFIX = "Movesense"

RECONNECT_BASE_DELAY = 1.0
RECONNECT_MAX_DELAY = 30.0

# --- Sensor configuration ---
# RECOMMENDED: fill in each sensor's fixed BLE address once you know it, so
# "left" and "right" always mean the same physical sensor every time you run
# this. Find each address from the discovery log printed on first run (see
# discover_sensors below), then hardcode it here for reliable, repeatable
# left/right labeling.
#
# Example once known:
# SENSOR_ADDRESSES = {
#     "left":  "AA:BB:CC:DD:EE:01",
#     "right": "AA:BB:CC:DD:EE:02",
# }
SENSOR_ADDRESSES: Dict[str, str] = {}

# If SENSOR_ADDRESSES is empty, the bridge auto-discovers this many sensors
# on startup and labels them sensor_1, sensor_2, ... in the order found.
# NOTE: discovery order is not guaranteed to be consistent between runs —
# switch to explicit SENSOR_ADDRESSES above once you know each sensor's
# address, if you need "left" and "right" to be stable across sessions.
AUTO_DISCOVER_COUNT = 2


class MovesenseBridge:
    """Owns the BLE connection to ONE Movesense sensor and keeps it alive."""

    def __init__(self, label: str, address: str, ws_clients: Set):
        self.label = label
        self.address = address
        self.ws_clients = ws_clients
        self.command_char: Optional[BleakGATTCharacteristic] = None
        self.data_char: Optional[BleakGATTCharacteristic] = None
        self.device_name: Optional[str] = None
        self._stop = False

    async def find_device(self):
        log.info(f"[{self.label}] Looking for device at {self.address}...")
        device = await BleakScanner.find_device_by_address(self.address, timeout=15.0)
        if device is None:
            raise RuntimeError(f"[{self.label}] Device {self.address} not found. Powered on and nearby?")
        log.info(f"[{self.label}] Found: {device.name} ({device.address})")
        return device

    def _notification_handler(self, _sender: BleakGATTCharacteristic, data: bytearray):
        if len(data) < 2:
            return
        response = data[0]
        reference = data[1]

        if response == RESP_COMMAND_RESULT:
            result_code = struct.unpack_from("<H", data, 2)[0] if len(data) >= 4 else None
            log.info(f"[{self.label}] Command result for ref {reference}: {result_code}")
            return

        if response == RESP_DATA and reference == REF_ACC:
            timestamp_ms = struct.unpack_from("<I", data, 2)[0]
            payload = data[6:]
            num_samples = len(payload) // 12
            for i in range(num_samples):
                x, y, z = struct.unpack_from("<fff", payload, i * 12)
                sample_time = timestamp_ms / 1000.0 + i / SAMPLE_RATE_HZ
                self._broadcast_sample(sample_time, x, y, z)

    def _broadcast_sample(self, t: float, x: float, y: float, z: float):
        message = json.dumps({
            "sensor": self.label,      # e.g. "left" / "right" / "sensor_1"
            "device": self.device_name,
            "t": t,
            "x": x,
            "y": y,
            "z": z,
        })
        stale = set()
        for ws in self.ws_clients:
            try:
                asyncio.create_task(ws.send(message))
            except Exception:
                stale.add(ws)
        self.ws_clients.difference_update(stale)

    async def connect_and_stream(self):
        device = await self.find_device()
        self.device_name = device.name

        disconnect_event = asyncio.Event()

        def on_disconnect(_client: BleakClient):
            log.warning(f"[{self.label}] Disconnected.")
            disconnect_event.set()

        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            log.info(f"[{self.label}] Connected. Discovering characteristics...")

            service = client.services.get_service(SENSORDATA_SERVICE_UUID)
            if service is None:
                raise RuntimeError(f"[{self.label}] sensordata-service not found")

            for char in service.characteristics:
                suffix = char.uuid[4:8]
                if suffix == COMMAND_CHAR_SUFFIX:
                    self.command_char = char
                elif suffix == DATA_CHAR_SUFFIX:
                    self.data_char = char

            if self.command_char is None or self.data_char is None:
                raise RuntimeError(f"[{self.label}] Could not find command/data characteristics")

            await client.start_notify(self.data_char, self._notification_handler)

            resource = f"{RESOURCE_PATH}/{SAMPLE_RATE_HZ}"
            subscribe_payload = bytes([CMD_SUBSCRIBE, REF_ACC]) + resource.encode("utf-8")
            await client.write_gatt_char(self.command_char, subscribe_payload, response=True)
            log.info(f"[{self.label}] Subscribed to {resource}")

            while not disconnect_event.is_set() and not self._stop:
                await asyncio.sleep(1.0)

        log.warning(f"[{self.label}] Stream loop ended.")

    async def run_forever(self):
        delay = RECONNECT_BASE_DELAY
        while not self._stop:
            try:
                await self.connect_and_stream()
                delay = RECONNECT_BASE_DELAY
            except Exception as e:
                log.error(f"[{self.label}] Connection attempt failed: {e}")

            if self._stop:
                break

            log.info(f"[{self.label}] Reconnecting in {delay:.1f}s...")
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY)

    def stop(self):
        self._stop = True


async def discover_sensors(count: int) -> Dict[str, str]:
    """One-time scan for up to `count` Movesense devices, labeled
    sensor_1, sensor_2, ... in the order found. Prints each address so you
    can copy it into SENSOR_ADDRESSES for stable left/right labeling later.

    Proceeds with however many sensors it actually finds (1 or more) rather
    than requiring an exact match — see the run-with-fewer-sensors note in
    main() for why that's a deliberate choice, not just a fallback."""
    log.info(f"Scanning for up to {count} Movesense sensor(s)...")
    found = await BleakScanner.discover(timeout=10.0)
    matches = [d for d in found if d.name and d.name.startswith(DEVICE_NAME_PREFIX)]

    if len(matches) == 0:
        raise RuntimeError(
            "No Movesense devices found at all. Make sure at least one sensor "
            "is powered on and nearby."
        )

    if len(matches) < count:
        log.warning(
            f"Only found {len(matches)} of {count} expected Movesense sensor(s). "
            f"Continuing with {len(matches)} — any data captured this session will "
            f"only cover {len(matches)} side(s) of the barbell."
        )

    addresses = {}
    for i, device in enumerate(matches[:count], start=1):
        label = f"sensor_{i}"
        addresses[label] = device.address
        log.info(f"Discovered {label}: {device.name} ({device.address}) "
                 f"— copy this address into SENSOR_ADDRESSES for stable labeling")

    return addresses


async def websocket_handler(websocket, ws_clients: Set):
    ws_clients.add(websocket)
    log.info(f"Viewer connected ({len(ws_clients)} total)")
    try:
        async for _ in websocket:
            pass
    finally:
        ws_clients.discard(websocket)
        log.info(f"Viewer disconnected ({len(ws_clients)} total)")


async def main():
    ws_clients: Set = set()

    addresses = SENSOR_ADDRESSES if SENSOR_ADDRESSES else await discover_sensors(AUTO_DISCOVER_COUNT)

    bridges = [MovesenseBridge(label, address, ws_clients) for label, address in addresses.items()]

    log.info(f"Active sensors this session: {list(addresses.keys())}")
    if len(bridges) == 1:
        log.warning(
            "Running with a SINGLE sensor. Any session recorded now will only "
            "capture one side of the barbell — tag this in your session metadata "
            "if you're storing this for research."
        )

    async def handler(websocket):
        await websocket_handler(websocket, ws_clients)

    server = await websockets.serve(handler, "localhost", 8765)
    log.info(f"WebSocket server listening on ws://localhost:8765 ({len(bridges)} sensors)")

    try:
        # Run every sensor's reconnect loop concurrently
        await asyncio.gather(*(bridge.run_forever() for bridge in bridges))
    finally:
        for bridge in bridges:
            bridge.stop()
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Shutting down.")