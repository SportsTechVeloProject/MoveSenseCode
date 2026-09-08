/**
 * storage.js
 * ==========
 * IndexedDB-backed session/sample storage. No backend — everything lives
 * in the browser. Exposes a single global, MSStorage.
 */

const MSStorage = (() => {
  const DB_NAME = "movesense-poc";
  const DB_VERSION = 1;

  let db = null;

  function init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const upgradeDb = event.target.result;

        if (!upgradeDb.objectStoreNames.contains("sessions")) {
          const sessions = upgradeDb.createObjectStore("sessions", {
            keyPath: "id",
            autoIncrement: true,
          });
          sessions.createIndex("by_startedAt", "startedAt");
        }

        if (!upgradeDb.objectStoreNames.contains("samples")) {
          const samples = upgradeDb.createObjectStore("samples", {
            keyPath: "id",
            autoIncrement: true,
          });
          samples.createIndex("by_session", "sessionId");
        }
      };

      req.onsuccess = (event) => {
        db = event.target.result;
        resolve(db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  function createSession(label, sensorLabels) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      const record = {
        label,
        startedAt: Date.now(),
        endedAt: null,
        sensorLabels,
        status: "recording",
        sampleCount: 0,
      };
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result); // new session id
      req.onerror = () => reject(req.error);
    });
  }

  function finalizeSession(sessionId, sampleCount) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      const getReq = store.get(sessionId);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (!record) {
          resolve();
          return;
        }
        record.endedAt = Date.now();
        record.status = "complete";
        record.sampleCount = sampleCount;
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  function putSamples(sessionId, batch) {
    if (!batch || batch.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("samples", "readwrite");
      const store = tx.objectStore("samples");
      for (const sample of batch) {
        store.put({
          sessionId,
          sensor: sample.sensor,
          t: sample.t,
          recvAt: sample.recvAt,
          x: sample.x,
          y: sample.y,
          z: sample.z,
          gx: sample.gx,
          gy: sample.gy,
          gz: sample.gz,
          vVert: sample.vVert,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function listSessions() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const index = tx.objectStore("sessions").index("by_startedAt");
      const results = [];
      const req = index.openCursor(null, "prev"); // newest first
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  function getSamplesForSession(sessionId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("samples", "readonly");
      const index = tx.objectStore("samples").index("by_session");
      const results = [];
      const req = index.openCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  function deleteSession(sessionId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "samples"], "readwrite");
      const sampleIndex = tx.objectStore("samples").index("by_session");
      const cursorReq = sampleIndex.openCursor(IDBKeyRange.only(sessionId));
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.objectStore("sessions").delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function toCsv(samples) {
    const header = "sessionId,sensor,t,recvAt,x,y,z,gx,gy,gz,vVert";
    const rows = samples.map(
      (s) =>
        `${s.sessionId},${s.sensor},${s.t},${s.recvAt},${s.x},${s.y},${s.z},${s.gx},${s.gy},${s.gz},${s.vVert}`
    );
    return [header, ...rows].join("\n");
  }

  async function exportSessionCsv(sessionId) {
    const samples = await getSamplesForSession(sessionId);
    return toCsv(samples);
  }

  return {
    init,
    createSession,
    finalizeSession,
    putSamples,
    listSessions,
    getSamplesForSession,
    deleteSession,
    exportSessionCsv,
  };
})();
