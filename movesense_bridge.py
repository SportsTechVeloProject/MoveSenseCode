"""
Movesense BLE Bridge
=====================
Connects to a Movesense sensor over BLE using bleak (a mature, native BLE
library), with automatic reconnection and exponential backoff on failure.
Parsed samples are re-broadcast to any connected browser clients over a
local WebSocket server, so your website never touches BLE directly.

Protocol constants below match the official Movesense "sensordata-service"
GATT protocol (same one used by movesense.html / the Web Bluetooth sample).

Install:
    pip install bleak websockets

Run:
    python movesense_bridge.py

In your website's JS:
    const ws = new WebSocket("ws://localhost:8765");
    ws.onmessage = (event) => {
        const sample = JSON.parse(event.data);
        // sample = {device, t, x, y, z}
        myCustomRenderer.update(sample);
    };
"""

import asyncio
import json
import logging
import struct
from typing import Optional, Set

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("movesense_bridge")

# --- Movesense GATT SensorData Protocol constants ---
SENSORDATA_SERVICE_UUID = "34802252-7185-4d5d-b431-630e7050e8f0"
COMMAND_CHAR_SUFFIX = "0001"  # last 4 hex digits of the command characteristic's UUID
DATA_CHAR_SUFFIX = "0002"     # last 4 hex digits of the data characteristic's UUID

# Commands (written to the command characteristic)
CMD_HELLO = 0
CMD_SUBSCRIBE = 1
CMD_UNSUBSCRIBE = 2

# Response types (first byte of a data-characteristic notification)
RESP_COMMAND_RESULT = 1
RESP_DATA = 2

# Reference tag we choose ourselves; the sensor echoes it back so we know
# which subscription a given notification belongs to.
REF_ACC = 99

# Resource path + sample rate. Change RESOURCE_PATH to "/Meas/IMU9" or
# "/Meas/Gyro" etc. if you want a different measurement; valid rates are
# sensor-dependent (commonly 13/26/52/104/208/416 Hz for Acc).
RESOURCE_PATH = "/Meas/Acc"
SAMPLE_RATE_HZ = 104

DEVICE_NAME_PREFIX = "Movesense"

RECONNECT_BASE_DELAY = 1.0   # seconds, doubles after each failed attempt
RECONNECT_MAX_DELAY = 30.0   # seconds, ceiling for backoff


class MovesenseBridge:
    """Owns the BLE connection to one Movesense sensor and keeps it alive."""

    def __init__(self, ws_clients: Set):
        self.ws_clients = ws_clients
        self.command_char: Optional[BleakGATTCharacteristic] = None
        self.data_char: Optional[BleakGATTCharacteristic] = None
        self.device_name: Optional[str] = None
        self._stop = False

    async def find_device(self):
        log.info("Scanning for Movesense sensor...")
        device = await BleakScanner.find_device_by_filter(
            lambda d, ad: d.name is not None and d.name.startswith(DEVICE_NAME_PREFIX),
            timeout=15.0,
        )
        if device is None:
            raise RuntimeError("No Movesense device found. Is it powered on and nearby?")
        log.info(f"Found device: {device.name} ({device.address})")
        return device

    def _notification_handler(self, _sender: BleakGATTCharacteristic, data: bytearray):
        if len(data) < 2:
            return
        response = data[0]
        reference = data[1]

        if response == RESP_COMMAND_RESULT:
            result_code = struct.unpack_from("<H", data, 2)[0] if len(data) >= 4 else None
            log.info(f"Command result for ref {reference}: {result_code}")
            return

        if response == RESP_DATA and reference == REF_ACC:
            # timestamp: uint32, little-endian, at bytes 2-5
            timestamp_ms = struct.unpack_from("<I", data, 2)[0]
            # remaining bytes: float32 x,y,z triplets, 12 bytes each
            payload = data[6:]
            num_samples = len(payload) // 12
            for i in range(num_samples):
                x, y, z = struct.unpack_from("<fff", payload, i * 12)
                sample_time = timestamp_ms / 1000.0 + i / SAMPLE_RATE_HZ
                self._broadcast_sample(sample_time, x, y, z)

    def _broadcast_sample(self, t: float, x: float, y: float, z: float):
        message = json.dumps({"device": self.device_name, "t": t, "x": x, "y": y, "z": z})
        stale = set()
        for ws in self.ws_clients:
            try:
                asyncio.create_task(ws.send(message))
            except Exception:
                stale.add(ws)
        self.ws_clients.difference_update(stale)

    async def connect_and_stream(self):
        """Connect once, subscribe, and stream until the connection drops.
        Raises on any failure so the outer loop can retry with backoff."""
        device = await self.find_device()
        self.device_name = device.name

        disconnect_event = asyncio.Event()

        def on_disconnect(_client: BleakClient):
            log.warning("Sensor disconnected.")
            disconnect_event.set()

        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            log.info("Connected. Discovering characteristics...")

            service = client.services.get_service(SENSORDATA_SERVICE_UUID)
            if service is None:
                raise RuntimeError("sensordata-service not found on device")

            for char in service.characteristics:
                suffix = char.uuid[4:8]
                if suffix == COMMAND_CHAR_SUFFIX:
                    self.command_char = char
                elif suffix == DATA_CHAR_SUFFIX:
                    self.data_char = char

            if self.command_char is None or self.data_char is None:
                raise RuntimeError("Could not find command/data characteristics")

            await client.start_notify(self.data_char, self._notification_handler)
            log.info("Notifications enabled. Subscribing to data stream...")

            resource = f"{RESOURCE_PATH}/{SAMPLE_RATE_HZ}"
            subscribe_payload = bytes([CMD_SUBSCRIBE, REF_ACC]) + resource.encode("utf-8")
            await client.write_gatt_char(self.command_char, subscribe_payload, response=True)
            log.info(f"Subscribed to {resource}")

            # Block here until the sensor disconnects or we're told to stop
            while not disconnect_event.is_set() and not self._stop:
                await asyncio.sleep(1.0)

        log.warning("Stream loop ended.")

    async def run_forever(self):
        """Outer loop: reconnects with exponential backoff on any failure."""
        delay = RECONNECT_BASE_DELAY
        while not self._stop:
            try:
                await self.connect_and_stream()
                delay = RECONNECT_BASE_DELAY  # reset backoff after a clean session
            except Exception as e:
                log.error(f"Connection attempt failed: {e}")

            if self._stop:
                break

            log.info(f"Reconnecting in {delay:.1f}s...")
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY)

    def stop(self):
        self._stop = True


async def websocket_handler(websocket, ws_clients: Set):
    ws_clients.add(websocket)
    log.info(f"Viewer connected ({len(ws_clients)} total)")
    try:
        async for _ in websocket:
            pass  # no messages expected from viewers; connection is one-way
    finally:
        ws_clients.discard(websocket)
        log.info(f"Viewer disconnected ({len(ws_clients)} total)")


async def main():
    ws_clients: Set = set()
    bridge = MovesenseBridge(ws_clients)

    async def handler(websocket):
        await websocket_handler(websocket, ws_clients)

    server = await websockets.serve(handler, "localhost", 8765)
    log.info("WebSocket server listening on ws://localhost:8765")

    try:
        await bridge.run_forever()
    finally:
        bridge.stop()
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Shutting down.")
