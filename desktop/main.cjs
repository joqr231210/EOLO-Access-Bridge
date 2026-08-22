const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow = null;
let bridgeServerPromise = null;
let bridgeContext = null;
let anprProcess = null;
let shutdownStarted = false;
let updateCheckTimer = null;
let updateCheckInFlight = null;

const DEFAULT_UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/joqr231210/EOLO-Access-Bridge/main/updates/windows-latest.json';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function readPackageMetadata() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(resourcePath('package.json'), 'utf8'));
    return {
      name: packageJson.name || 'eolo-access-bridge',
      productName: packageJson.productName || 'EOLO Access Bridge',
      version: packageJson.version || app.getVersion()
    };
  } catch {
    return {
      name: 'eolo-access-bridge',
      productName: 'EOLO Access Bridge',
      version: app.getVersion()
    };
  }
}

function currentAppVersion() {
  return app.getVersion() || readPackageMetadata().version;
}

function compareVersions(a, b) {
  const parse = (value) =>
    String(value || '')
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
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
        {
          label: 'Buscar actualizaciones',
          click: () => checkForInstallerUpdate({ manual: true })
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

function updateManifestUrl() {
  return (
    process.env.EOLO_DESKTOP_UPDATE_MANIFEST_URL ||
    process.env.EOLO_UPDATE_MANIFEST_URL ||
    DEFAULT_UPDATE_MANIFEST_URL
  ).trim();
}

function updatesDirectory() {
  const directory = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors for temporary update files.
  }
}

async function fetchUpdateManifest() {
  const url = updateManifestUrl();
  if (!url) return null;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    throw new Error(`No se pudo consultar manifiesto de actualizaciones (${response.status}).`);
  }
  return response.json();
}

function platformUpdateFromManifest(manifest = {}) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  const platformBlock = manifest[platform] || manifest.platforms?.[platform] || manifest.downloads?.[platform] || {};
  const candidate = platformBlock[arch] || platformBlock.x64 || platformBlock.default || platformBlock;
  if (typeof candidate === 'string') return { url: candidate };
  return candidate || {};
}

function normalizeUpdateInfo(manifest = {}) {
  const platformUpdate = platformUpdateFromManifest(manifest);
  return {
    version: String(platformUpdate.version || manifest.version || '').replace(/^v/i, ''),
    url: String(platformUpdate.url || manifest.url || ''),
    sha256: String(platformUpdate.sha256 || manifest.sha256 || '').toLowerCase(),
    notes: String(platformUpdate.notes || manifest.notes || ''),
    mandatory: Boolean(platformUpdate.mandatory || manifest.mandatory),
    publishedAt: String(platformUpdate.publishedAt || manifest.publishedAt || '')
  };
}

async function downloadUpdateInstaller(updateInfo) {
  const response = await fetch(updateInfo.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) {
    throw new Error(`No se pudo descargar el instalador (${response.status}).`);
  }
  if (!response.body) {
    throw new Error('La respuesta de descarga no tiene contenido.');
  }
  const fileNameFromUrl = path.basename(new URL(updateInfo.url).pathname) || `EOLO Access Bridge Setup ${updateInfo.version}.exe`;
  const safeFileName = fileNameFromUrl.replace(/[<>:"/\\|?*]+/g, '-');
  const filePath = path.join(updatesDirectory(), safeFileName);
  const tempPath = `${filePath}.download`;
  const hash = crypto.createHash('sha256');
  const writer = fs.createWriteStream(tempPath);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      if (!writer.write(chunk)) {
        await new Promise((resolve) => writer.once('drain', resolve));
      }
    }
  } catch (error) {
    writer.destroy();
    safeUnlink(tempPath);
    throw error;
  }
  await new Promise((resolve, reject) => {
    writer.end(resolve);
    writer.once('error', reject);
  });
  if (updateInfo.sha256) {
    const digest = hash.digest('hex');
    if (digest.toLowerCase() !== updateInfo.sha256) {
      safeUnlink(tempPath);
      throw new Error('La descarga no coincide con el checksum SHA-256 esperado.');
    }
  }
  fs.renameSync(tempPath, filePath);
  return filePath;
}

async function promptInstallDownloadedUpdate(updateInfo, installerPath) {
  const detailLines = [
    `Version actual: ${currentAppVersion()}`,
    `Nueva version: ${updateInfo.version}`,
    updateInfo.notes ? `\n${updateInfo.notes}` : '',
    '\nAl iniciar el instalador se cerrara EOLO Access Bridge y se detendran sus procesos locales.'
  ].filter(Boolean);
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Actualizacion lista',
    message: 'La actualizacion de EOLO Access Bridge ya esta descargada.',
    detail: detailLines.join('\n'),
    buttons: ['Instalar ahora', 'Abrir carpeta', 'Despues'],
    defaultId: 0,
    cancelId: 2
  });
  if (result.response === 1) {
    await shell.showItemInFolder(installerPath);
    return;
  }
  if (result.response !== 0) return;
  launchInstallerAfterExit(installerPath);
  app.quit();
}

function launchInstallerAfterExit(installerPath) {
  if (process.platform !== 'win32') {
    spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    return;
  }
  const launcherPath = path.join(updatesDirectory(), `install-after-exit-${Date.now()}.cmd`);
  const escapedInstallerPath = installerPath.replace(/"/g, '""');
  const script = [
    '@echo off',
    'setlocal',
    `set "EOLO_PID=${process.pid}"`,
    `set "EOLO_INSTALLER=${escapedInstallerPath}"`,
    ':wait',
    'tasklist /FI "PID eq %EOLO_PID%" | find "%EOLO_PID%" >nul',
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    'start "" "%EOLO_INSTALLER%"',
    'del "%~f0"',
    ''
  ].join(os.EOL);
  fs.writeFileSync(launcherPath, script);
  spawn(process.env.ComSpec || 'cmd.exe', ['/c', launcherPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref();
}

async function offerInstallerUpdate(updateInfo, { manual = false } = {}) {
  const detailLines = [
    `Version actual: ${currentAppVersion()}`,
    `Nueva version: ${updateInfo.version}`,
    updateInfo.publishedAt ? `Publicada: ${updateInfo.publishedAt}` : '',
    updateInfo.notes ? `\n${updateInfo.notes}` : ''
  ].filter(Boolean);
  const result = await dialog.showMessageBox(mainWindow, {
    type: updateInfo.mandatory ? 'warning' : 'info',
    title: 'Actualizacion disponible',
    message: 'Hay una nueva version de EOLO Access Bridge para Windows.',
    detail: detailLines.join('\n'),
    buttons: ['Descargar instalador', 'Abrir enlace', manual ? 'Cerrar' : 'Despues'],
    defaultId: 0,
    cancelId: 2
  });
  if (result.response === 1) {
    await shell.openExternal(updateInfo.url);
    return;
  }
  if (result.response !== 0) return;
  const progress = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Descargando actualizacion',
    message: 'Se descargara el instalador. La app seguira funcionando durante la descarga.',
    buttons: ['Continuar'],
    defaultId: 0
  });
  if (progress.response !== 0) return;
  const installerPath = await downloadUpdateInstaller(updateInfo);
  await promptInstallDownloadedUpdate(updateInfo, installerPath);
}

async function checkForInstallerUpdate({ manual = false } = {}) {
  if (process.platform !== 'win32') {
    if (manual) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Actualizaciones asistidas',
        message: 'El actualizador asistido esta habilitado para instalaciones Windows.'
      });
    }
    return null;
  }
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
    try {
      const manifest = await fetchUpdateManifest();
      const updateInfo = normalizeUpdateInfo(manifest);
      if (!updateInfo.version) {
        throw new Error('El manifiesto de actualizacion no tiene version.');
      }
      if (compareVersions(updateInfo.version, currentAppVersion()) <= 0) {
        if (manual) {
          await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'EOLO Access Bridge actualizado',
            message: `Ya tienes la version mas reciente (${currentAppVersion()}).`
          });
        }
        return null;
      }
      if (!updateInfo.url) {
        throw new Error('El manifiesto de actualizacion no tiene URL de instalador.');
      }
      await offerInstallerUpdate(updateInfo, { manual });
      return updateInfo;
    } catch (error) {
      if (manual) {
        await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'No se pudo buscar actualizaciones',
          message: error?.message || String(error),
          detail: `Manifiesto: ${updateManifestUrl()}`
        });
      } else {
        console.warn('No se pudo buscar actualizaciones', error);
      }
      return null;
    } finally {
      updateCheckInFlight = null;
    }
  })();
  return updateCheckInFlight;
}

function startUpdateChecks() {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (!updateManifestUrl()) return;
  setTimeout(() => checkForInstallerUpdate({ manual: false }).catch(() => {}), 15000);
  updateCheckTimer = setInterval(
    () => checkForInstallerUpdate({ manual: false }).catch(() => {}),
    UPDATE_CHECK_INTERVAL_MS
  );
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
    startUpdateChecks();
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
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (anprProcess && anprProcess.exitCode === null && !anprProcess.killed) {
    stopAnprSidecar({ force: true }).catch(() => {});
  }
});
