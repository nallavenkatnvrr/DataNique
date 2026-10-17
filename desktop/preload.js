// Preload - runs in an isolated context before the renderer loads.
//
// Its only job is to expose the loopback backend's base URL to the React app
// as `window.__API_BASE__`. The frontend's api/client.ts reads that and
// prefixes every /api call with it (and main.tsx switches to HashRouter when
// it is present). The port is passed from the main process via
// additionalArguments so it stays in sync with the spawned backend.

const { contextBridge } = require("electron");

function readApiBase() {
  const arg = process.argv.find((a) => a.startsWith("--datanique-api-base="));
  return arg ? arg.split("=")[1] : "http://127.0.0.1:8000";
}

const apiBase = readApiBase();

// contextIsolation is on, so the value reaches the page only through contextBridge.
contextBridge.exposeInMainWorld("__API_BASE__", apiBase);
