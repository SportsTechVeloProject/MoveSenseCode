/**
 * movesense-client.js
 * ====================
 * Runs in the browser, on your website. Connects to the local
 * movesense_bridge.py WebSocket server and receives parsed IMU samples.
 *
 * This file has NO Bluetooth code at all — the bridge handles that.
 * All this does is listen and hand samples off to your own display logic.
 *
 * Include it in your HTML with:
 *   <script src="js/movesense-client.js"></script>
 */

let bridgeSocket = null;

function connectToBridge() {
    bridgeSocket = new WebSocket("ws://localhost:8765");

    bridgeSocket.onopen = () => {
        console.log("Connected to Movesense bridge");
        onBridgeStatusChange("connected");
    };

    bridgeSocket.onmessage = (event) => {
        const sample = JSON.parse(event.data);
        // sample = { device: "Movesense 1234567890", t: 12.345, x: 0.1, y: -0.9, z: 9.8 }
        onSample(sample);
    };

    bridgeSocket.onclose = () => {
        console.log("Bridge connection closed — retrying in 2s...");
        onBridgeStatusChange("disconnected");
        setTimeout(connectToBridge, 2000);
    };

    bridgeSocket.onerror = (err) => {
        console.error("Bridge WebSocket error:", err);
    };
}

/**
 * Called every time a new sample arrives from the sensor.
 * THIS is where your own display/analysis code goes — replace the
 * console.log below with whatever you actually want to do with the data
 * (update a chart, compute velocity, feed a table, etc.).
 */
function onSample(sample) {
    console.log(sample);
    // Example: myCustomRenderer.update(sample);
}

/**
 * Called whenever the bridge connection state changes.
 * Hook this up to a status indicator in your UI if you want one.
 */
function onBridgeStatusChange(status) {
    console.log("Bridge status:", status);
    // Example: document.getElementById('status').innerText = status;
}

// Start listening as soon as this script loads
connectToBridge();
