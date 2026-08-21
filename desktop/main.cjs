const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow = null;
let bridgeServerPromise = null;
let bridgeContext = null;
let anprProcess = null;
let shutdownStarted = false;

function appRootPath() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

function resourcePath(...segments) {
  return path.join(appRootPath(), ...segments);
}

function executableName(baseName) {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function canUsePort(port) {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '0.0.0.0');
    });
  });
}

async function findPort(preferredPort) {
  const preferred = Number.parseInt(preferredPort || '18080', 10);
  const start = Number.isFinite(preferred) ? preferred : 18080;
  for (let port = start; port < start + 40; port += 1) {
    if (await canUsePort(port)) return port;
  }
  throw new Error(`No se encontro un puerto libre desde ${start}`);
}

async function configureBridgeEnvironment() {
  const userDataDir = app.getPath('userData');
  const dataDir = path.join(userDataDir, 'data');
  const uploadDir = path.join(userDataDir, 'uploads');
  const anprDataDir = path.join(userDataDir, 'anpr');
  const anprSnapshotDir = path.join(anprDataDir, 'snapshots');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(anprDataDir, { recursive: true });
  fs.mkdirSync(anprSnapshotDir, { recursive: true });

  const port = await findPort(process.env.PORT || '18080');
  const anprPort = await findPort(process.env.ANPR_API_PORT || '8090');
  const anprBaseUrl = `http://127.0.0.1:${anprPort}`;
  const configFile = path.join(anprDataDir, 'config.json');
  const defaultConfigFile = firstExisting([
    resourcePath('sidecars', 'anpr', 'config.default.json'),
    resourcePath('sidecars', 'anpr', '_internal', 'config.default.json'),
    resourcePath('AnprEolo', 'config.default.json')
  ]);
  if (!fs.existsSync(configFile) && defaultConfigFile) {
    fs.copyFileSync(defaultConfigFile, configFile);
  }

  const go2rtcTarget = `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`;
  const go2rtcBinary = firstExisting([
    resourcePath('sidecars', 'go2rtc', go2rtcTarget, executableName('go2rtc')),
    resourcePath('vendor', 'sidecars', 'go2rtc', go2rtcTarget, executableName('go2rtc')),
    process.platform === 'win32' ? '' : '/usr/local/bin/go2rtc',
    process.platform === 'win32' ? '' : '/opt/homebrew/bin/go2rtc'
  ]);

  process.env.PORT = String(port);
  process.env.DATA_DIR = process.env.DATA_DIR || dataDir;
  process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || uploadDir;
  process.env.EOLO_DESKTOP = '1';
  process.env.ANPR_API_PORT = process.env.ANPR_API_PORT || String(anprPort);
  process.env.ANPR_API_BASE_URL = process.env.ANPR_API_BASE_URL || anprBaseUrl;
  process.env.ANPR_CONTROL_BASE_URL = process.env.ANPR_CONTROL_BASE_URL || anprBaseUrl;
  process.env.ANPR_RUNTIME_DIR = process.env.ANPR_RUNTIME_DIR || anprDataDir;
  process.env.ANPR_DATA_DIR = process.env.ANPR_DATA_DIR || anprDataDir;
  process.env.ANPR_DB_FILE = process.env.ANPR_DB_FILE || path.join(anprDataDir, 'plates.db');
  process.env.ANPR_CONFIG_FILE = process.env.ANPR_CONFIG_FILE || configFile;
  process.env.ANPR_DETECTIONS_FILE =
    process.env.ANPR_DETECTIONS_FILE || path.join(anprDataDir, 'anpr-detections.json');
  process.env.ANPR_STATUS_FILE =
    process.env.ANPR_STATUS_FILE || path.join(anprDataDir, 'anpr-status.json');
  process.env.ANPR_SNAPSHOT_DIR = process.env.ANPR_SNAPSHOT_DIR || anprSnapshotDir;
  process.env.ANPR_STREAM_PUBLIC_URL = process.env.ANPR_STREAM_PUBLIC_URL || 'http://localhost:8083';
  process.env.ANPR_WEBRTC_API_URL = process.env.ANPR_WEBRTC_API_URL || 'http://127.0.0.1:1984';
  process.env.ANPR_WEBRTC_PUBLIC_URL = process.env.ANPR_WEBRTC_PUBLIC_URL || 'http://localhost:1984';
  process.env.GO2RTC_BINARY = process.env.GO2RTC_BINARY || go2rtcBinary;
  process.env.GO2RTC_CONFIG_FILE =
    process.env.GO2RTC_CONFIG_FILE || path.join(anprDataDir, 'go2rtc.yaml');

  return {
    port,
    anprPort,
    anprBaseUrl,
    dataDir,
    uploadDir,
    anprDataDir,
    anprSnapshotDir,
    go2rtcBinary,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

function anprExecutablePath() {
  return firstExisting([
    resourcePath('sidecars', 'anpr', executableName('anpr-eolo')),
    resourcePath('dist', 'anpr-eolo', executableName('anpr-eolo'))
  ]);
}

function sourceAnprScriptPath() {
  return resourcePath('AnprEolo', 'web_config.py');
}

function appendLog(filePath, chunk) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFile(filePath, chunk, () => {});
}

function startAnprSidecar(context) {
  if (anprProcess && anprProcess.exitCode === null && !anprProcess.killed) {
    return true;
  }
  const logFile = path.join(context.anprDataDir, 'anpr-sidecar.log');
  const sidecarPath = anprExecutablePath();
  const env = {
    ...process.env,
    PORT: String(context.anprPort),
    ANPR_API_PORT: String(context.anprPort),
    ANPR_CONTROL_BASE_URL: context.anprBaseUrl
  };

  let command = sidecarPath;
  let args = [];
  let cwd = context.anprDataDir;

  if (!command) {
    const sourceScript = sourceAnprScriptPath();
    if (!fs.existsSync(sourceScript)) {
      appendLog(logFile, `[desktop] ANPR sidecar no encontrado\n`);
      return false;
    }
    command = process.env.PYTHON || 'python3';
    args = [sourceScript];
    cwd = path.dirname(sourceScript);
  }

  anprProcess = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  anprProcess.stdout.on('data', (chunk) => appendLog(logFile, chunk));
  anprProcess.stderr.on('data', (chunk) => appendLog(logFile, chunk));
  anprProcess.on('exit', (code, signal) => {
    appendLog(logFile, `[desktop] ANPR sidecar finalizo code=${code} signal=${signal}\n`);
    anprProcess = null;
  });
  anprProcess.on('error', (error) => {
    appendLog(logFile, `[desktop] ANPR sidecar error: ${error.stack || error.message}\n`);
    anprProcess = null;
  });
  appendLog(logFile, `[desktop] ANPR sidecar iniciado: ${command} ${args.join(' ')}\n`);
  return true;
}

function killProcessTree(processRef, logFile) {
  if (!processRef || processRef.exitCode !== null || processRef.killed) return Promise.resolve();
  const pid = processRef.pid;
  if (process.platform === 'win32' && pid) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (error, stdout, stderr) => {
        appendLog(
          logFile,
          `[desktop] taskkill pid=${pid} error=${error ? error.message : 'none'} stdout=${stdout || ''} stderr=${stderr || ''}\n`
        );
        resolve();
      });
    });
  }
  processRef.kill('SIGTERM');
  return new Promise((resolve) => setTimeout(resolve, 600));
}

async function stopAnprSidecar({ force = false } = {}) {
  if (!anprProcess) return;
  const logFile = path.join(bridgeContext?.anprDataDir || app.getPath('userData'), 'anpr-sidecar.log');
  const processRef = anprProcess;
  appendLog(logFile, `[desktop] Deteniendo ANPR sidecar force=${force}\n`);
  if (force || process.platform === 'win32') {
    await killProcessTree(processRef, logFile);
  } else {
    processRef.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (processRef.exitCode === null && !processRef.killed) {
    processRef.kill('SIGKILL');
  }
  if (anprProcess === processRef) anprProcess = null;
}

async function restartAnprSidecar() {
  if (!bridgeContext) return;
  await stopAnprSidecar({ force: true });
  startAnprSidecar(bridgeContext);
}

async function waitForService(url, attempts = 80) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error(`Servicio no respondio: ${url}`);
}

async function stopManagedProcesses() {
  if (bridgeContext?.baseUrl) {
    await fetch(`${bridgeContext.baseUrl}/api/services/webrtc-preview/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(2500)
    }).catch(() => {});
  }
  if (anprProcess && anprProcess.exitCode === null && !anprProcess.killed) {
    await stopAnprSidecar({ force: true });
  }
}

async function startBridgeServer() {
  if (!bridgeServerPromise) {
    const serverPath = path.join(__dirname, '..', 'src', 'server.js');
    bridgeServerPromise = import(pathToFileURL(serverPath).href);
  }
  return bridgeServerPromise;
}

async function waitForBridge(baseUrl) {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('EOLO Access Bridge no respondio a healthcheck');
}

function buildApplicationMenu() {
  const template = [
    {
      label: 'EOLO Access Bridge',
      submenu: [
        {
          label: 'Operador',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.loadURL(`${bridgeContext.baseUrl}/`)
        },
        {
          label: 'Ajustes',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.loadURL(`${bridgeContext.baseUrl}/settings`)
        },
        { type: 'separator' },
        {
          label: 'Abrir carpeta de datos',
          click: () => shell.openPath(bridgeContext.dataDir)
        },
        {
          label: 'Abrir carpeta de fotos',
          click: () => shell.openPath(bridgeContext.uploadDir)
        },
        {
          label: 'Abrir carpeta ANPR',
          click: () => shell.openPath(bridgeContext.anprDataDir)
        },
        { type: 'separator' },
        {
          label: 'Detener ANPR',
          click: () => stopAnprSidecar({ force: true })
        },
        {
          label: 'Reiniciar ANPR',
          click: () => restartAnprSidecar()
        },
        { type: 'separator' },
        { role: 'reload', label: 'Recargar' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollador' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1160,
    minHeight: 760,
    title: 'EOLO Access Bridge',
    autoHideMenuBar: false,
    show: false,
    backgroundColor: '#f4f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`${bridgeContext.baseUrl}/`);
}

async function boot() {
  try {
    bridgeContext = await configureBridgeEnvironment();
    startAnprSidecar(bridgeContext);
    await waitForService(`${bridgeContext.anprBaseUrl}/api/health`).catch((error) => {
      console.warn('ANPR sidecar no respondio durante el arranque', error);
    });
    await startBridgeServer();
    await waitForBridge(bridgeContext.baseUrl);
    buildApplicationMenu();
    createWindow();
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'No se pudo iniciar EOLO Access Bridge',
      message: 'No se pudo arrancar el servicio local.',
      detail: error?.stack || error?.message || String(error)
    });
    app.quit();
  }
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && bridgeContext) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  stopManagedProcesses().finally(() => {
    app.quit();
  });
});

app.on('will-quit', () => {
  if (anprProcess && anprProcess.exitCode === null && !anprProcess.killed) {
    stopAnprSidecar({ force: true }).catch(() => {});
  }
});
