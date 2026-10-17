// Datanique desktop shell (Electron main process).
//
// Responsibilities:
//   1. Pick a free loopback port and spawn the FastAPI backend:
//        - dev  : the project's Python venv running run_server.py
//        - prod : the PyInstaller-frozen datanique-backend(.exe) bundled as an
//                 extraResource under process.resourcesPath.
//   2. Wait until the backend's /api/health responds, then create the window
//      and load the built React UI from the loopback FastAPI origin in prod, or
//      the Vite dev server when DATANIQUE_DEV=1.
//   3. Wire electron-updater so the app self-updates from the configured feed.
//   4. Cleanly kill the backend on quit.

const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const log = require("electron-log");
const getPort = require("get-port");
const { autoUpdater } = require("electron-updater");

log.transports.file.level = "info";
autoUpdater.logger = log;

const isDev = process.env.DATANIQUE_DEV === "1";
const PROJECT_ROOT = path.resolve(__dirname, "..");

let backendProc = null;
let backendPort = 8000;
let mainWindow = null;

// --- Backend process management --------------------------------------------

function backendEnv(port) {
  // Persist DB + encryption key under the per-user Electron data dir so the
  // frozen backend has a writable, stable home (its own dir is read-only when
  // packaged, and would be wiped on every update).
  const dataDir = path.join(app.getPath("userData"), "backend-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    DV_BIND_HOST: "127.0.0.1",
    DV_BIND_PORT: String(port),
    DV_API_TOKEN: "",
    DV_ADMIN_TOKEN: "",
    DV_DATA_DIR: dataDir,
    // Absolute key file inside the writable data dir (dev-fallback key path).
    DV_SECRET_KEY_FILE: path.join(dataDir, ".secret_key"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
  };
  if (!isDev) {
    env.DV_STATIC_DIR = path.join(process.resourcesPath, "renderer");
  }
  return env;
}

function spawnBackend(port) {
  const env = backendEnv(port);

  if (isDev) {
    // Dev: run the source backend through the project's venv Python.
    const backendDir = path.join(PROJECT_ROOT, "backend");
    const pyExe = path.join(backendDir, ".venv", "Scripts", "python.exe");
    const exe = fs.existsSync(pyExe) ? pyExe : "python";
    log.info(`[backend] dev spawn: ${exe} run_server.py (port ${port})`);
    return spawn(exe, ["run_server.py"], { cwd: backendDir, env, windowsHide: true });
  }

  // Prod: the frozen backend is packaged under resources/backend/.
  const backendDir = path.join(process.resourcesPath, "backend");
  const exe = path.join(
    backendDir,
    process.platform === "win32" ? "datanique-backend.exe" : "datanique-backend"
  );
  log.info(`[backend] prod spawn: ${exe} (port ${port})`);
  return spawn(exe, [], { cwd: backendDir, env, windowsHide: true });
}

function waitForHealth(port, timeoutMs = 60000, child = null) {
  const started = Date.now();
  const url = `http://127.0.0.1:${port}/api/health`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer = null;
    let request = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (err && request) request.destroy();
      if (err) reject(err);
      else resolve();
    };
    const retry = () => {
      if (settled || retryTimer) return;
      if (Date.now() - started > timeoutMs) {
        return finish(new Error("Backend did not become healthy in time"));
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        tick();
      }, 400);
    };
    const onChildExit = (code, signal) => {
      const status = signal ? `signal ${signal}` : `code ${code}`;
      finish(new Error(`Backend process exited before becoming healthy (${status})`));
    };
    const tick = () => {
      if (settled) return;
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return finish();
        retry();
      });
      request = req;
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy());
    };

    if (child) {
      child.once("error", (err) => finish(err));
      child.once("exit", onChildExit);
    }
    tick();
  });
}

async function startBackend() {
  // In dev the user may already have a backend on 8000; reuse it if healthy.
  if (isDev) {
    try {
      await waitForHealth(8000, 1500);
      log.info("[backend] reusing already-running dev backend on 8000");
      backendPort = 8000;
      return;
    } catch {
      /* none running - spawn our own below */
    }
  }

  backendPort = await getPort({ port: getPort.makeRange(8123, 8299) });
  backendProc = spawnBackend(backendPort);
  const child = backendProc;

  child.stdout && child.stdout.on("data", (d) => log.info(`[backend] ${d}`.trimEnd()));
  child.stderr && child.stderr.on("data", (d) => log.info(`[backend] ${d}`.trimEnd()));
  child.once("error", () => {
    if (backendProc === child) backendProc = null;
  });
  child.on("exit", (code) => {
    log.warn(`[backend] exited with code ${code}`);
    if (backendProc === child) backendProc = null;
  });

  await waitForHealth(backendPort, 60000, child);
  log.info(`[backend] healthy on ${backendPort}`);
}

function killBackend() {
  if (backendProc && !backendProc.killed) {
    log.info("[backend] terminating");
    try {
      if (process.platform === "win32") {
        // Ensure the whole tree dies (uvicorn may spawn children).
        spawn("taskkill", ["/pid", String(backendProc.pid), "/f", "/t"], { windowsHide: true });
      } else {
        backendProc.kill("SIGTERM");
      }
    } catch (e) {
      log.error("[backend] kill failed", e);
    }
    backendProc = null;
  }
}

// --- Window -----------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0b0f1a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload injects window.__API_BASE__ pointing at the loopback
      // backend; additionalArguments carries the chosen port across the bridge.
      additionalArguments: [`--datanique-api-base=http://127.0.0.1:${backendPort}`],
    },
  });

  // Open external links (docs etc.) in the system browser, not a new window.
  // Only http(s) links leave the app; file:, smb:, custom schemes are refused.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // The window only ever shows the loopback backend (or the dev server).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = [`http://127.0.0.1:${backendPort}/`, process.env.DATANIQUE_VITE_URL].filter(Boolean);
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev && process.env.DATANIQUE_VITE_URL) {
    mainWindow.loadURL(process.env.DATANIQUE_VITE_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else if (isDev) {
    mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
  }

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => (mainWindow = null));
}

// --- Auto update ------------------------------------------------------------

function setupAutoUpdate() {
  if (isDev) return; // never check for updates while developing
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-available", (info) =>
    log.info(`[updater] update available: ${info.version}`)
  );
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      title: "Update ready",
      message: `Datanique ${info.version} has been downloaded.`,
      detail: "Restart the app to apply the update.",
    });
    if (response === 0) {
      killBackend();
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on("error", (err) => log.error("[updater] error", err));
  autoUpdater.checkForUpdatesAndNotify().catch((e) => log.error(e));
}

// --- App lifecycle ----------------------------------------------------------

// Single-instance: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
    } catch (err) {
      log.error("[backend] failed to start", err);
      dialog.showErrorBox(
        "Datanique failed to start",
        `The backend service did not start.\n\n${err.message}\n\nSee logs: ${log.transports.file.getFile().path}`
      );
      app.quit();
      return;
    }
    createWindow();
    setupAutoUpdate();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      killBackend();
      app.quit();
    }
  });

  app.on("before-quit", killBackend);
  process.on("exit", killBackend);
}
