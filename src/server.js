import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { DahuaClient } from './dahuaClient.js';
import { DahuaEventStream } from './dahuaEventStream.js';
import { HikvisionClient } from './hikvisionClient.js';
import { MockDevice } from './mockDevice.js';
import { EoloClient } from './eoloClient.js';
import { EoloUserSync } from './eoloUserSync.js';
import { DeviceEventStream } from './eventStream.js';
import { TaskRunner } from './taskRunner.js';
import { addEvent, bus, ensureDataDirs, getEvents, getLogs, getStoredLogs, log } from './logger.js';
import { loadRuntimeConfig, publicRuntimeConfig, saveRuntimeConfig } from './runtimeConfig.js';
import { ServiceManager, remoteAnprService } from './serviceManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

await loadRuntimeConfig();
await ensureDataDirs();

const app = express();
const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se aceptan imagenes JPEG o PNG'));
  }
});

const eoloClient = new EoloClient();
const operatorSessions = new Map();
const operatorCloudSessionCache = new Map();
const operatorInventorySummaryCache = new Map();
const operatorAccessVisionKeyCache = new Map();
const OPERATOR_ACCESS_PERMISSION_DATA_TYPE = 'permisoaccesos';
const OPERATOR_ACCESS_PERMISSION_BUILDPRINT_TYPE = 'custom.permisoaccesos';
const OPERATOR_ACCESS_PERMISSION_VALID_UNTIL_FIELD = 'vigenciafinal_date';
const OPERATOR_ACCESS_DEVICE_DATA_TYPE = config.operator.deviceDataType || 'dispositivosacceso';
const OPERATOR_PERMISSION_ID2_ENDPOINT = config.operator.permissionId2Endpoint || 'bridge_access_permission_id2';
let latestOperatorCloudSession = null;
let go2rtcProcess = null;
let device = createDevice();
let eventStream = createEventStream();
const faceDeviceStreams = new Map();
let taskRunner = new TaskRunner(device, eoloClient);
let eoloUserSync = new EoloUserSync(device, eoloClient, {
  runHandler: runEoloUserSyncForEligibleFaceDevices
});
const serviceManager = new ServiceManager();
let operatorId2CounterQueue = Promise.resolve();
const facialMovementEventKeys = new Set();
const facialMovementContextCache = new Map();
let go2rtcDesiredRunning = false;
let go2rtcWatchdogTimer = null;
let go2rtcRestarting = false;
let shutdownRequested = false;
registerServices();

app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'operator.html'));
});

app.get('/settings', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get(['/producto', '/product'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'product.html'));
});

app.get(['/operator', '/operator.html', '/operador', '/operador.html'], (_req, res) => {
  res.redirect(302, '/');
});

app.get('/index.html', (_req, res) => {
  res.redirect(302, '/settings');
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir, { index: false }));

const asyncRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

async function fetchAnprJson(pathname, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;
  const url = `${config.anpr.baseUrl}${pathname}`;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const wrapped = new Error(`ANPR no respondio ${method} ${pathname}: ${error.message}`);
    wrapped.status = 502;
    wrapped.cause = error;
    wrapped.upstream = { service: 'anpr', method, url, pathname, timeoutMs };
    throw wrapped;
  }
  const rawBody = await response.text().catch(() => '');
  const contentType = response.headers.get('content-type') || '';
  let payload = rawBody;
  if (contentType.includes('application/json') && rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch (_error) {
      payload = { raw: rawBody };
    }
  }
  if (!response.ok) {
    const upstreamMessage = typeof payload === 'object'
      ? payload.error || payload.detail || payload.message
      : payload;
    const error = new Error(`ANPR ${method} ${pathname} respondio ${response.status}: ${upstreamMessage || response.statusText}`);
    error.status = response.status;
    error.body = payload;
    error.upstream = {
      service: 'anpr',
      method,
      url,
      pathname,
      status: response.status,
      statusText: response.statusText,
      diagnostics: payload && typeof payload === 'object' ? payload.diagnostics : undefined
    };
    throw error;
  }
  return payload;
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function maskRtspUrl(value) {
  const text = String(value || '').trim();
  if (!text || !text.includes('@')) return text;
  const [schemePart, rest] = text.includes('://') ? text.split('://', 2) : ['', text];
  const host = rest.split('@').slice(1).join('@');
  return schemePart ? `${schemePart}://***:***@${host}` : `***:***@${host}`;
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

function safeStreamName(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function go2rtcCandidateHost() {
  if (config.anpr.webrtcIceHost) return config.anpr.webrtcIceHost;
  try {
    const url = new URL(config.anpr.webrtcPublicUrl);
    return url.hostname || 'localhost';
  } catch (_error) {
    return 'localhost';
  }
}

function go2rtcStatus() {
  const running = Boolean(go2rtcProcess && go2rtcProcess.exitCode === null && !go2rtcProcess.killed);
  return {
    running,
    status: running ? 'running' : 'stopped',
    pid: running ? go2rtcProcess.pid : null,
    publicUrl: config.anpr.webrtcPublicUrl,
    apiUrl: config.anpr.webrtcApiUrl,
    port: config.anpr.webrtcPort
  };
}

async function loadAnprRtspCameras() {
  const hardware = await fetchAnprJson('/api/hardware', { timeoutMs: 8000 });
  return (hardware.cameras || [])
    .map((camera) => ({
      name: safeStreamName(camera.name || ''),
      originalName: camera.name || '',
      type: camera.type || '',
      prefix: camera.prefix || '',
      rtspUrl: camera.rtsp_url || camera.rtsp || ''
    }))
    .filter((camera) => camera.name && camera.rtspUrl);
}

async function writeGo2rtcConfig(cameras) {
  const dir = path.dirname(config.anpr.go2rtcConfigFile);
  fs.mkdirSync(dir, { recursive: true });
  const candidate = `${go2rtcCandidateHost()}:${config.anpr.webrtcPort}`;
  const lines = [
    'api:',
    '  listen: ":1984"',
    'rtsp:',
    '  listen: "127.0.0.1:8554"',
    'webrtc:',
    `  listen: ":${config.anpr.webrtcPort}"`,
    `  candidates: [${yamlQuote(candidate)}]`,
    'streams:'
  ];
  if (!cameras.length) {
    lines.push('  placeholder: []');
  } else {
    for (const camera of cameras) {
      lines.push(`  ${yamlQuote(camera.name)}:`);
      lines.push(`    - ${yamlQuote(camera.rtspUrl)}`);
    }
  }
  fs.writeFileSync(config.anpr.go2rtcConfigFile, `${lines.join('\n')}\n`, 'utf8');
  return config.anpr.go2rtcConfigFile;
}

async function isGo2rtcReachable() {
  try {
    const response = await fetch(`${config.anpr.webrtcApiUrl}/api/streams`, {
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function go2rtcLogPath() {
  return path.join(config.dataDir, 'go2rtc.log');
}

function pipeProcessToFile(child, filePath, label) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  stream.write(`[${new Date().toISOString()}] ${label} iniciado\n`);
  child.stdout?.on('data', (chunk) => stream.write(chunk));
  child.stderr?.on('data', (chunk) => stream.write(chunk));
  child.once('close', (code, signal) => {
    stream.write(`[${new Date().toISOString()}] ${label} finalizo code=${code} signal=${signal}\n`);
    stream.end();
  });
}

function scheduleGo2rtcWatchdog() {
  clearGo2rtcWatchdog();
  go2rtcWatchdogTimer = setInterval(async () => {
    if (!go2rtcDesiredRunning || go2rtcRestarting) return;
    const running = go2rtcStatus().running;
    const reachable = running ? await isGo2rtcReachable() : false;
    if (running && reachable) return;
    go2rtcRestarting = true;
    try {
      await log('warn', 'Visualizador WebRTC no responde; reiniciando go2rtc', {
        running,
        reachable
      });
      await startGo2rtcPreview({ preserveDesired: true });
    } catch (error) {
      await log('error', 'No se pudo reiniciar go2rtc automaticamente', {
        error: error.message
      });
    } finally {
      go2rtcRestarting = false;
    }
  }, 15000);
  go2rtcWatchdogTimer.unref?.();
}

function clearGo2rtcWatchdog() {
  if (go2rtcWatchdogTimer) clearInterval(go2rtcWatchdogTimer);
  go2rtcWatchdogTimer = null;
}

async function startGo2rtcPreview() {
  go2rtcDesiredRunning = true;
  if (!config.anpr.webrtcEnabled) {
    const error = new Error('El visualizador WebRTC esta deshabilitado.');
    error.status = 400;
    throw error;
  }
  const cameras = await loadAnprRtspCameras();
  await writeGo2rtcConfig(cameras);
  if (go2rtcStatus().running && (await isGo2rtcReachable())) {
    scheduleGo2rtcWatchdog();
    return { ...go2rtcStatus(), cameras: cameras.length };
  }
  await stopGo2rtcPreview({ preserveDesired: true });
  let spawnError = null;
  go2rtcProcess = spawn(config.anpr.go2rtcBinary, ['-config', config.anpr.go2rtcConfigFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  pipeProcessToFile(go2rtcProcess, go2rtcLogPath(), 'go2rtc');
  go2rtcProcess.on('error', (error) => {
    spawnError = error;
    log('error', 'No se pudo iniciar go2rtc', {
      error: error.message,
      binary: config.anpr.go2rtcBinary
    }).catch(() => {});
    go2rtcProcess = null;
  });
  go2rtcProcess.on('exit', (code, signal) => {
    log('warn', 'Visualizador WebRTC detenido', { code, signal }).catch(() => {});
    go2rtcProcess = null;
    if (go2rtcDesiredRunning && !shutdownRequested) {
      setTimeout(() => {
        if (go2rtcDesiredRunning && !go2rtcRestarting) {
          startGo2rtcPreview({ preserveDesired: true }).catch((error) => {
            log('error', 'No se pudo reiniciar go2rtc tras salida inesperada', {
              error: error.message
            }).catch(() => {});
          });
        }
      }, 2000).unref?.();
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (spawnError) throw spawnError;
  if (!(await isGo2rtcReachable())) {
    const error = new Error('go2rtc inicio, pero su API WebRTC no esta respondiendo.');
    error.status = 502;
    throw error;
  }
  await log('info', 'Visualizador WebRTC iniciado', {
    pid: go2rtcProcess.pid,
    cameras: cameras.length,
    publicUrl: config.anpr.webrtcPublicUrl
  });
  scheduleGo2rtcWatchdog();
  return { ...go2rtcStatus(), cameras: cameras.length };
}

async function stopGo2rtcPreview(options = {}) {
  if (!options.preserveDesired) go2rtcDesiredRunning = false;
  if (!options.preserveDesired) clearGo2rtcWatchdog();
  if (go2rtcProcess && go2rtcProcess.exitCode === null && !go2rtcProcess.killed) {
    go2rtcProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  go2rtcProcess = null;
  return go2rtcStatus();
}

app.get(
  '/api/health',
  asyncRoute(async (req, res) => {
    await getOperatorSession(req).catch(() => null);
    res.json({
      ok: true,
      mode: config.mockDevice ? 'mock' : 'device',
      faceDevice: config.faceDevice,
      deviceHost: activeFaceDeviceSettings().host,
      devicePort: activeFaceDeviceSettings().port,
      deviceProtocol: activeFaceDeviceSettings().protocol,
      eoloConfigured: eoloClient.enabled,
      eoloUserSync: eoloUserSyncStatus(),
      stream: eventStream?.status() || { running: Boolean(device.interval) }
    });
  })
);

app.get(
  '/api/services',
  asyncRoute(async (_req, res) => {
    res.json({ services: await serviceManager.list() });
  })
);

app.post(
  '/api/services/:id/start',
  asyncRoute(async (req, res) => {
    const service = await serviceManager.start(req.params.id);
    await log('info', 'Servicio iniciado desde Bridge', { serviceId: req.params.id });
    res.json({ ok: true, service, services: await serviceManager.list() });
  })
);

app.post(
  '/api/services/:id/stop',
  asyncRoute(async (req, res) => {
    const service = await serviceManager.stop(req.params.id);
    await log('info', 'Servicio detenido desde Bridge', { serviceId: req.params.id });
    res.json({ ok: true, service, services: await serviceManager.list() });
  })
);

app.post(
  '/api/services/:id/restart',
  asyncRoute(async (req, res) => {
    const service = await serviceManager.restart(req.params.id);
    await log('info', 'Servicio reiniciado desde Bridge', { serviceId: req.params.id });
    res.json({ ok: true, service, services: await serviceManager.list() });
  })
);

app.get('/api/device-config', (_req, res) => {
  res.json(publicRuntimeConfig());
});

app.put(
  '/api/device-config',
  asyncRoute(async (req, res) => {
    stopCurrentStream();
    const saved = await saveRuntimeConfig(req.body);
    rebuildDeviceClients();
    eoloUserSync.restart();
    const validation = await validateCurrentDevice();
    await log(validation.ok ? 'info' : 'warn', 'Configuracion del dispositivo guardada', {
      faceDevice: config.faceDevice,
      host: activeFaceDeviceSettings().host,
      port: activeFaceDeviceSettings().port,
      protocol: activeFaceDeviceSettings().protocol,
      validationOk: validation.ok,
      eoloUserSyncEnabled: config.eolo.userSyncEnabled,
      eoloAccessSet: Boolean(config.eolo.access),
      eoloTokenSet: Boolean(config.eolo.token)
    });
    res.json({ ok: true, config: saved, validation });
  })
);

app.post(
  '/api/device-config/test',
  asyncRoute(async (req, res) => {
    const result = await validateDeviceConfig(req.body, Boolean(req.body.mockDevice));
    res.json(result);
  })
);

app.get('/api/face-devices', (_req, res) => {
  res.json({ ok: true, devices: faceDevicesWithStatus() });
});

app.post(
  '/api/face-devices/streams/start-enabled',
  asyncRoute(async (_req, res) => {
    const results = [];
    for (const target of eligibleFaceDevices()) {
      try {
        const result = await startFaceDeviceStream(target);
        await setFaceDeviceStreamDesired(target.id, true);
        results.push({ deviceId: target.id, ok: true, result });
      } catch (error) {
        results.push({ deviceId: target.id, ok: false, error: error.message });
      }
    }
    res.json({ ok: results.every((item) => item.ok), results, devices: faceDevicesWithStatus() });
  })
);

app.post(
  '/api/face-devices/streams/stop-all',
  asyncRoute(async (_req, res) => {
    const results = [];
    for (const target of config.faceDevices) {
      results.push({ deviceId: target.id, result: await stopFaceDeviceStream(target.id) });
    }
    await persistFaceDevices(config.faceDevices.map((target) => ({ ...target, streamDesired: false })));
    res.json({ ok: true, results, devices: faceDevicesWithStatus() });
  })
);

app.post(
  '/api/face-devices',
  asyncRoute(async (req, res) => {
    const deviceInput = normalizeFaceDeviceInput(req.body);
    const next = [
      ...config.faceDevices,
      {
        ...deviceInput,
        id: crypto.randomUUID(),
        lastTestOk: false,
        lastTestAt: '',
        lastTestMessage: 'Dispositivo guardado; prueba la comunicacion antes de sincronizar.',
        lastTestStatus: '',
        lastTestTarget: '',
        streamDesired: false
      }
    ];
    await persistFaceDevices(next);
    await log('info', 'Dispositivo facial agregado', {
      deviceId: next.at(-1).id,
      type: next.at(-1).type,
      host: next.at(-1).host
    });
    res.status(201).json({ ok: true, devices: faceDevicesWithStatus() });
  })
);

app.put(
  '/api/face-devices/:id',
  asyncRoute(async (req, res) => {
    const existing = findFaceDevice(req.params.id);
    const updated = normalizeFaceDeviceInput(req.body, existing);
    const passwordChanged =
      Object.prototype.hasOwnProperty.call(req.body || {}, 'password') && req.body.password !== '';
    const testStillValid =
      !passwordChanged &&
      faceDeviceConnectionSignature(existing) === faceDeviceConnectionSignature(updated);
    const next = config.faceDevices.map((item) =>
      item.id === existing.id
        ? {
          ...updated,
          id: existing.id,
          lastTestOk: testStillValid ? Boolean(existing.lastTestOk) : false,
          lastTestAt: testStillValid ? existing.lastTestAt || '' : '',
          lastTestMessage: testStillValid
            ? existing.lastTestMessage || ''
            : 'Configuracion modificada; prueba la comunicacion antes de sincronizar.',
          lastTestStatus: testStillValid ? existing.lastTestStatus || '' : '',
          lastTestTarget: testStillValid ? existing.lastTestTarget || '' : ''
        }
        : item
    );
    await persistFaceDevices(next);
    await log('info', 'Dispositivo facial actualizado', {
      deviceId: existing.id,
      type: updated.type,
      host: updated.host
    });
    res.json({ ok: true, devices: faceDevicesWithStatus() });
  })
);

app.delete(
  '/api/face-devices/:id',
  asyncRoute(async (req, res) => {
    const existing = findFaceDevice(req.params.id);
    await stopFaceDeviceStream(existing.id);
    await persistFaceDevices(config.faceDevices.filter((item) => item.id !== existing.id));
    await log('info', 'Dispositivo facial eliminado', {
      deviceId: existing.id,
      type: existing.type,
      host: existing.host
    });
    res.json({ ok: true, devices: faceDevicesWithStatus() });
  })
);

app.post(
  '/api/face-devices/:id/test',
  asyncRoute(async (req, res) => {
    const existing = findFaceDevice(req.params.id);
    const candidate = req.body && Object.keys(req.body).length
      ? normalizeFaceDeviceInput(req.body, existing)
      : existing;
    const result = await validateFaceDevice(candidate);
    const testMatchesSavedConfig =
      faceDeviceConnectionSignature(existing) === faceDeviceConnectionSignature(candidate);
    if (testMatchesSavedConfig) {
      await updateFaceDeviceTestState(existing.id, result);
      result.saved = true;
    } else {
      result.saved = false;
      result.message = `${result.message} Guarda esta configuracion y vuelve a probar para marcar el equipo como probado.`;
    }
    result.devices = faceDevicesWithStatus();
    res.json(result);
  })
);

app.post(
  '/api/face-devices/:id/stream/start',
  asyncRoute(async (req, res) => {
    const target = findFaceDevice(req.params.id);
    const result = await startFaceDeviceStream(target);
    await setFaceDeviceStreamDesired(target.id, true);
    res.json({ ok: true, result, devices: faceDevicesWithStatus() });
  })
);

app.post(
  '/api/face-devices/:id/stream/stop',
  asyncRoute(async (req, res) => {
    const target = findFaceDevice(req.params.id);
    const result = await stopFaceDeviceStream(target.id);
    await setFaceDeviceStreamDesired(target.id, false);
    res.json({ ok: true, result, devices: faceDevicesWithStatus() });
  })
);

app.post(
  '/api/face-devices/:id/sync-device',
  asyncRoute(async (req, res) => {
    const target = findFaceDevice(req.params.id);
    ensureFaceDeviceSyncEligible(target);
    const sync = new EoloUserSync(createFaceDeviceClient(target), eoloClient);
    const result = await sync.applySnapshotToDevice();
    await log('info', 'Snapshot EOLO cargado a dispositivo facial', {
      deviceId: target.id,
      type: target.type,
      host: target.host,
      created: result.created?.length || 0,
      updated: result.updated?.length || 0,
      deleted: result.deleted?.length || 0
    });
    res.json({ ok: true, result, devices: faceDevicesWithStatus() });
  })
);

app.get(
  '/api/device-info',
  asyncRoute(async (_req, res) => {
    try {
      const [deviceInfo, capabilities] = await Promise.all([
        device.deviceInfo(),
        device.capabilities()
      ]);
      res.json({ ok: true, deviceInfo, capabilities });
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  })
);

app.get(
  '/api/employees',
  asyncRoute(async (req, res) => {
    const maxResults = Number.parseInt(req.query.limit || '30', 10);
    const position = Number.parseInt(req.query.position || '0', 10);
    const employeeNo = req.query.employeeNo ? String(req.query.employeeNo) : undefined;
    await log('info', 'Consultando empleados en dispositivo facial', {
      faceDevice: config.faceDevice,
      employeeNo,
      maxResults,
      position
    });
    const result = await device.searchEmployees({ employeeNo, maxResults, position });
    const normalized = normalizeEmployeeSearch(result);
    res.json({ ok: true, ...normalized });
  })
);

app.post(
  '/api/employees',
  asyncRoute(async (req, res) => {
    const employee = normalizeEmployee(req.body);
    await log('info', 'Enviando alta de empleado a dispositivo facial', {
      faceDevice: config.faceDevice,
      employeeNo: employee.employeeNo,
      userInfo: device.toUserInfo ? device.toUserInfo(employee) : employee
    });
    const result = await device.createEmployee(employee);
    await log('info', 'Alta de empleado completada', { employeeNo: employee.employeeNo });
    res.status(201).json({ ok: true, employee, result });
  })
);

app.put(
  '/api/employees/:employeeNo',
  asyncRoute(async (req, res) => {
    const employee = normalizeEmployee({ ...req.body, employeeNo: req.params.employeeNo });
    await log('info', 'Enviando modificacion de empleado a dispositivo facial', {
      faceDevice: config.faceDevice,
      employeeNo: req.params.employeeNo,
      userInfo: device.toUserInfo ? device.toUserInfo(employee) : employee
    });
    const result = await device.updateEmployee(req.params.employeeNo, employee);
    await log('info', 'Modificacion de empleado completada', {
      employeeNo: req.params.employeeNo
    });
    res.json({ ok: true, employee, result });
  })
);

app.delete(
  '/api/employees/:employeeNo',
  asyncRoute(async (req, res) => {
    const result = await device.deleteEmployee(req.params.employeeNo);
    await log('info', 'Baja de empleado completada', { employeeNo: req.params.employeeNo });
    res.json({ ok: true, employeeNo: req.params.employeeNo, result });
  })
);

app.post(
  '/api/employees/:employeeNo/face',
  upload.single('face'),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'La imagen es obligatoria en el campo face' });
      return;
    }
    await log('info', 'Enviando rostro a dispositivo facial', {
      faceDevice: config.faceDevice,
      employeeNo: req.params.employeeNo,
      file: req.file.originalname,
      faceRecord: {
        faceLibType: activeFaceDeviceSettings().faceLibType,
        FDID: activeFaceDeviceSettings().fdid,
        FPID: String(req.params.employeeNo)
      }
    });
    const result = await device.uploadFace(req.params.employeeNo, req.file.path, {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype
    });
    await log('info', 'Rostro cargado al dispositivo', {
      employeeNo: req.params.employeeNo,
      file: req.file.originalname
    });
    res.json({ ok: true, employeeNo: req.params.employeeNo, result });
  })
);

app.post(
  '/api/eolo/tasks',
  asyncRoute(async (req, res) => {
    const tasks = Array.isArray(req.body) ? req.body : req.body.tasks || [req.body];
    const results = [];
    for (const task of tasks) {
      results.push(await taskRunner.run(task));
    }
    res.json({ ok: true, results });
  })
);

app.post(
  '/api/eolo/tasks/poll',
  asyncRoute(async (_req, res) => {
    const count = await taskRunner.pollOnce();
    res.json({ ok: true, processed: count });
  })
);

app.get('/api/eolo/users-sync/status', asyncRoute(async (req, res) => {
  await getOperatorSession(req).catch(() => null);
  res.json(eoloUserSyncStatus());
}));

app.post(
  '/api/eolo/users-sync/run',
  asyncRoute(async (req, res) => {
    const operatorSession = await getOperatorSession(req).catch(() => null);
    const requestToken = getOperatorToken(req);
    const result = await runEoloUserSyncForEligibleFaceDevices({
      token: operatorSession?.token || requestToken,
      userId: operatorSession?.userId
    });
    res.json(result);
  })
);

app.post(
  '/api/eolo/users-sync/cloud-download',
  asyncRoute(async (req, res) => {
    const operatorSession = await getOperatorSession(req).catch(() => null);
    const requestToken = getOperatorToken(req);
    const tokenContext = resolveEoloUserSyncToken({
      token: operatorSession?.token || requestToken,
      userId: operatorSession?.userId
    });
    const accessId = String(req.body?.access || req.query.access || config.eolo.access || '').trim();
    const result = await downloadEoloSnapshotFromOperatorPermissions({
      token: tokenContext.token,
      userId: tokenContext.userId,
      accessId,
      tokenSource: tokenContext.source
    });
    res.json(result);
  })
);

app.post(
  '/api/eolo/users-sync/device-apply',
  asyncRoute(async (_req, res) => {
    const result = await applySnapshotToEligibleFaceDevices();
    res.json(result);
  })
);

app.get(
  '/api/anpr/dashboard',
  asyncRoute(async (_req, res) => {
    try {
      res.json(await fetchAnprJson('/api/dashboard'));
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  })
);

app.get(
  '/api/anpr/hardware',
  asyncRoute(async (_req, res) => {
    try {
      res.json(await fetchAnprJson('/api/hardware'));
    } catch (error) {
      res.json({ ok: false, error: error.message });
    }
  })
);

app.get(
  '/api/anpr/config',
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/config'));
  })
);

app.get(
  '/api/anpr/diagnostics',
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/anpr/diagnostics', { timeoutMs: 5000 }));
  })
);

app.put(
  '/api/anpr/config',
  asyncRoute(async (req, res) => {
    res.json(
      await fetchAnprJson('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: 10000
      })
    );
  })
);

app.put(
  '/api/anpr/hardware',
  asyncRoute(async (req, res) => {
    res.json(
      await fetchAnprJson('/api/hardware', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: 10000
      })
    );
  })
);

app.post(
  '/api/anpr/barriers/:id/open',
  asyncRoute(async (req, res) => {
    res.json(
      await fetchAnprJson(`/open/${encodeURIComponent(req.params.id)}`, {
        method: 'POST',
        timeoutMs: 10000
      })
    );
  })
);

app.post(
  '/api/anpr/sync-now',
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/sync_now', { method: 'POST', timeoutMs: 20000 }));
  })
);

app.get(['/stream-player/:camera', '/operator/stream-player/:camera'], (req, res) => {
  res.redirect(302, `/webrtc-player/${encodeURIComponent(req.params.camera || '')}`);
});

app.get(['/webrtc-player/:camera', '/operator/webrtc-player/:camera'], (req, res) => {
  const cameraName = safeStreamName(req.params.camera || '');
  const playerUrl = new URL('/stream.html', config.anpr.webrtcPublicUrl);
  playerUrl.searchParams.set('src', cameraName);
  playerUrl.searchParams.set('stream', 'webrtc');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #101828; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #101828; }
  </style>
</head>
<body>
  <iframe
    title="WebRTC ${escapeHtmlText(cameraName || 'camara')}"
    src="${escapeHtmlText(playerUrl.toString())}"
    allow="autoplay; fullscreen; camera; microphone"
    loading="eager"></iframe>
</body>
</html>`);
});

app.get(
  '/api/operator/stream-cameras',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    const hardware = await fetchAnprJson('/api/hardware', { timeoutMs: 8000 });
    let webrtcStatus = go2rtcStatus();
    let streamError = '';
    if (config.anpr.webrtcEnabled && !webrtcStatus.running) {
      try {
        webrtcStatus = await startGo2rtcPreview();
      } catch (error) {
        streamError = error.message;
        await log('warn', 'No se pudo activar Visualizador RTC automaticamente', {
          error: error.message
        });
        webrtcStatus = go2rtcStatus();
      }
    }
    const useWebrtc = Boolean(config.anpr.webrtcEnabled && webrtcStatus.running);
    const cameras = (hardware.cameras || [])
      .map((camera) => {
        const rtspUrl = camera.rtsp_url || camera.rtsp || '';
        const name = camera.name || '';
        return {
          name,
          type: camera.type || '',
          prefix: camera.prefix || '',
          hasRtsp: Boolean(camera.has_rtsp || rtspUrl),
          rtspUrl: maskRtspUrl(rtspUrl),
          playerMode: 'webrtc',
          playerUrl: `/webrtc-player/${encodeURIComponent(name)}`
        };
      })
      .filter((camera) => camera.hasRtsp && camera.name);
    res.json({
      ok: true,
      cameras,
      stream: {
        running: useWebrtc,
        status: useWebrtc ? 'running' : 'stopped',
        mode: 'webrtc',
        publicUrl: config.anpr.webrtcPublicUrl,
        error: streamError
      }
    });
  })
);

app.post(
  '/api/operator/stream-cameras/start',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    await startGo2rtcPreview();
    res.json(await fetchAnprJson('/api/services', { timeoutMs: 5000 }));
  })
);

app.post(
  '/api/operator/stream-cameras/stop',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    await stopGo2rtcPreview();
    res.json(await fetchAnprJson('/api/services', { timeoutMs: 5000 }));
  })
);

app.get(
  '/api/operator/anpr-detections',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/anpr/detections', { timeoutMs: 3000 }));
  })
);

app.get(
  '/api/operator/anpr-status',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/anpr/status', { timeoutMs: 3000 }));
  })
);

app.get(
  '/api/operator/anpr-snapshots/:camera',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const response = await fetch(
      `${config.anpr.baseUrl}/api/anpr/snapshots/${encodeURIComponent(req.params.camera)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) {
      const payload = await response.json().catch(async () => ({ error: await response.text() }));
      res.status(response.status).json({
        ok: false,
        error: payload.error || 'No se pudo obtener la fotografia de la camara.'
      });
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.type(response.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  })
);

app.get(
  '/api/operator/session',
  asyncRoute(async (req, res) => {
    const session = await getOperatorSession(req);
    res.json({
      ok: Boolean(session),
      authenticated: Boolean(session),
      operator: session?.operator || null,
      userId: session?.userId || null,
      expiresAt: session?.expiresAt || null,
      syncIntervalMs: config.operator.syncIntervalMs
    });
  })
);

app.post(
  '/api/operator/login',
  asyncRoute(async (req, res) => {
    const mode = String(req.body.mode || 'pin').toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const pin = String(req.body.pin || '').trim();
    const code = String(req.body.code || '').trim();
    if (config.operator.authMode === 'cloud') {
      const session = await loginOperatorWithBubble({ mode, phone, pin, code });
      rememberOperatorCloudSession(session);
      await log('info', 'Sesion de operador iniciada en EOLO Cloud', {
        phone,
        mode,
        userId: session.userId,
        version: config.operator.appVersion
      });
      res.json({
        ok: true,
        token: session.token,
        userId: session.userId,
        expiresAt: session.expiresAt,
        operator: session.operator,
        syncIntervalMs: config.operator.syncIntervalMs
      });
      return;
    }

    const credentialOk =
      (mode === 'pin' && pin === config.operator.pin) ||
      (mode === 'sms' && code === config.operator.smsCode);

    if (!phone) {
      const error = new Error('El telefono es obligatorio para iniciar sesion.');
      error.status = 400;
      throw error;
    }
    if (!credentialOk) {
      const error = new Error('Credenciales de operador no validas.');
      error.status = 401;
      throw error;
    }

    const token = crypto.randomBytes(24).toString('hex');
    const operator = {
      name: config.operator.defaultName,
      company: config.operator.defaultCompany,
      phone,
      authMode: mode,
      loggedAt: new Date().toISOString()
    };
    operatorSessions.set(token, { token, operator, createdAt: Date.now() });
    await log('info', 'Sesion de operador iniciada', { phone, mode });
    res.json({ ok: true, token, operator, syncIntervalMs: config.operator.syncIntervalMs });
  })
);

app.post(
  '/api/operator/logout',
  asyncRoute(async (req, res) => {
    const token = getOperatorToken(req);
    if (token) operatorSessions.delete(token);
    forgetOperatorCloudSession(token);
    if (token) {
      for (const key of operatorCloudSessionCache.keys()) {
        if (key.startsWith(`${token}:`)) operatorCloudSessionCache.delete(key);
      }
      for (const key of operatorAccessVisionKeyCache.keys()) {
        if (key.startsWith(`${token}:`)) operatorAccessVisionKeyCache.delete(key);
      }
    }
    res.json({ ok: true });
  })
);

app.get(
  '/api/operator/accesses',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    if (config.operator.authMode === 'cloud') {
      const cloudAccesses = await fetchOperatorCloudAccesses(req.operatorSession).catch(
        async (error) => {
          await log('warn', 'No se pudieron consultar accesos de operador en EOLO Cloud', {
            error: error.message,
            status: error.status,
            endpoint: config.operator.accessesEndpoint
          });
          return null;
        }
      );
      if (cloudAccesses) {
        rememberOperatorAccessVisionKeys(req.operatorSession, cloudAccesses);
        res.json({
          ok: true,
          source: 'cloud',
          accesses: cloudAccesses
        });
        return;
      }
    }

    const payload = await fetchAnprJson('/api/config').catch(() => ({}));
    const cfg = payload.config || payload;
    const cameras = Array.isArray(cfg.cameras) ? cfg.cameras : [];
    const configuredAccess = cfg.id_acceso || config.eolo.access || '';
    res.json({
      ok: true,
      source: 'local-fallback',
      accesses: [
        {
          id: configuredAccess || 'local-access',
          name: config.operator.defaultAccessName,
          active: true,
          cameras: cameras.map((camera) => ({
            name: camera.name,
            type: camera.type,
            prefix: camera.prefix
          }))
        }
      ]
    });
  })
);

app.get(
  '/api/operator/control-points',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para consultar puntos de control.');
      error.status = 400;
      throw error;
    }

    if (config.operator.authMode === 'cloud') {
      const cloudControlPoints = await fetchOperatorCloudControlPoints(
        req.operatorSession,
        accessId
      ).catch(async (error) => {
        await log('warn', 'No se pudieron consultar puntos de control en EOLO Cloud', {
          error: error.message,
          status: error.status,
          endpoint: config.operator.controlPointsEndpoint,
          accessId
        });
        return null;
      });
      if (cloudControlPoints) {
        res.json({
          ok: true,
          source: 'cloud',
          controlPoints: cloudControlPoints
        });
        return;
      }
    }

    const payload = await fetchAnprJson('/api/config').catch(() => ({}));
    const cfg = payload.config || payload;
    const cameras = Array.isArray(cfg.cameras) ? cfg.cameras : [];
    const entryCamera = cameras.find((camera) => camera.type === 'Entrada') || cameras[0] || {};
    const exitCamera = cameras.find((camera) => camera.type === 'Salida') || {};
    res.json({
      ok: true,
      source: 'local-fallback',
      controlPoints: [
        {
          id: cfg.id_punto_control || cfg.id_accesoconfiguracion || 'local-control-point',
          accessId,
          name: config.operator.defaultAccessName,
          type: 'ambos',
          actionType: 'solo_registrar',
          requestType: 'ambos',
          phone: '',
          address: '',
          cameras: cameras.map((camera) => ({
            name: camera.name,
            type: camera.type,
            prefix: camera.prefix
          })),
          entryCamera: entryCamera.name || '',
          exitCamera: exitCamera.name || '',
          active: true
        }
      ]
    });
  })
);

app.get(
  '/api/operator/access-devices',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para consultar dispositivos EOLO.');
      error.status = 400;
      throw error;
    }
    if (config.operator.authMode !== 'cloud') {
      res.json({ ok: true, source: 'local-disabled', devices: [] });
      return;
    }

    const devices = await fetchOperatorCloudAccessDevices(req.operatorSession, accessId)
      .catch(async (error) => {
        await log('warn', 'No se pudieron consultar DispositivosAcceso en EOLO Cloud', {
          error: error.message,
          status: error.status,
          dataType: OPERATOR_ACCESS_DEVICE_DATA_TYPE,
          accessId
        });
        if (isBubbleDataTypeNotFoundError(error)) {
          return [];
        }
        throw error;
      });
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      source: 'cloud-data-api',
      dataType: OPERATOR_ACCESS_DEVICE_DATA_TYPE,
      accessId,
      devices
    });
  })
);

app.post(
  '/api/operator/access-devices',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const accessId = firstText(body.accessId, body.access_id, req.query.access, req.query.access_id).trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para crear el DispositivosAcceso.');
      error.status = 400;
      throw error;
    }
    if (config.operator.authMode !== 'cloud') {
      const error = new Error('La creacion de DispositivosAcceso requiere sesion EOLO Cloud.');
      error.status = 409;
      throw error;
    }

    const result = await upsertOperatorCloudAccessDevice(req.operatorSession, {
      accessId,
      localDeviceId: body.localDeviceId,
      deviceId: body.deviceId,
      name: body.name,
      bridgeIdentifier: body.bridgeIdentifier,
      controlPointId: body.controlPointId,
      controlPointName: body.controlPointName,
      type: body.type,
      host: body.host,
      port: body.port,
      protocol: body.protocol
    });
    const devices = await fetchOperatorCloudAccessDevices(req.operatorSession, accessId)
      .catch(() => (result.device ? [result.device] : []));
    res.status(201).json({
      ok: true,
      source: 'cloud-workflow',
      accessId,
      device: result.device,
      devices,
      workflow: result.workflow
    });
  })
);

app.get(
  '/api/operator/inventory-summary',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para consultar inventario.');
      error.status = 400;
      throw error;
    }

    if (config.operator.authMode === 'cloud') {
      const summary = await fetchOperatorCloudInventorySummary(req.operatorSession, accessId);
      res.json({
        ok: true,
        source: 'cloud',
        summary
      });
      return;
    }

    const params = new URLSearchParams({ access: accessId, status: 'Ingresado', limit: '100', offset: '0' });
    const payload = await fetchAnprJson(`/api/operator/movements?${params}`, { timeoutMs: 12000 });
    res.json({
      ok: true,
      source: payload.source || 'local-fallback',
      summary: payload.summary || summarizeOperatorMovements(payload.movements || [])
    });
  })
);

app.get(
  '/api/operator/movements',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    const controlPointId = String(req.query.control_point || req.query.control_point_id || '').trim();
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const limit = movementPageLimit(req.query.limit);
    const offset = movementPageOffset(req.query.offset);
    const sort = String(req.query.sort || 'modified_desc').trim() || 'modified_desc';
    const includeSummary = String(req.query.include_summary || 'true') !== 'false';
    const hasLocalFilters = Boolean(req.query.search || req.query.status || req.query.kind);
    if (config.operator.authMode === 'cloud' && accessId) {
      const cloudResult = await fetchOperatorCloudMovementsToday(
        req.operatorSession,
        accessId,
        controlPointId,
        {
          dateFrom,
          dateTo,
          limit: hasLocalFilters ? '' : limit,
          offset: hasLocalFilters ? '' : offset,
          sort
        }
      ).catch(async (error) => {
        await log('warn', 'No se pudieron consultar movimientos de operador en EOLO Cloud', {
          error: error.message,
          status: error.status,
          endpoint: config.operator.movementsEndpoint,
          accessId,
          controlPointId
        });
        return null;
      });
      if (cloudResult) {
        const cloudMovements = Array.isArray(cloudResult.movements) ? cloudResult.movements : cloudResult;
        const filteredMovements = sortOperatorMovements(filterOperatorMovements(cloudMovements, req.query), req.query);
        const cloudTotal = Number(cloudResult.total);
        const cloudWasPaginated =
          !hasLocalFilters && Number.isFinite(cloudTotal) && cloudTotal >= filteredMovements.length;
        const movements = cloudWasPaginated ? filteredMovements : paginateOperatorMovements(filteredMovements, req.query);
        const summary = includeSummary
          ? await fetchOperatorCloudInventorySummary(req.operatorSession, accessId).catch(async (error) => {
              await log('warn', 'No se pudo consultar inventario real en EOLO Cloud', {
                error: error.message,
                status: error.status,
                accessId
              });
              return summarizeOperatorMovements(filteredMovements);
            })
          : undefined;
        res.json({
          ok: true,
          source: 'cloud',
          movements,
          total: cloudWasPaginated ? cloudTotal : filteredMovements.length,
          count: movements.length,
          limit,
          offset,
          sort,
          ...(summary ? { summary } : {})
        });
        return;
      }
    }

    const params = new URLSearchParams();
    for (const key of ['date', 'date_from', 'date_to', 'access', 'control_point', 'search', 'status', 'kind', 'limit', 'offset', 'sort']) {
      if (req.query[key]) params.set(key, String(req.query[key]));
    }
    const suffix = params.toString() ? `?${params}` : '';
    res.json(await fetchAnprJson(`/api/operator/movements${suffix}`, { timeoutMs: 12000 }));
  })
);

app.get(
  '/api/operator/residents',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    const search = String(req.query.search || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para consultar residentes.');
      error.status = 400;
      throw error;
    }

    if (config.operator.authMode === 'cloud') {
      const residents = await fetchOperatorCloudResidents(req.operatorSession, accessId, search)
        .catch(async (error) => {
          await log('warn', 'No se pudieron consultar residentes de acceso en EOLO Cloud', {
            error: error.message,
            status: error.status,
            endpoint: config.operator.residentsEndpoint,
            accessId
          });
          return null;
        });
      if (residents) {
        res.json({
          ok: true,
          source: 'cloud',
          residents
        });
        return;
      }
    }

    res.json({ ok: true, source: 'local-fallback', residents: [] });
  })
);

app.get(
  '/api/operator/access-permissions',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    const search = String(req.query.search || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para consultar permisos.');
      error.status = 400;
      throw error;
    }

    if (config.operator.authMode === 'cloud') {
      const cloudPermissions = await fetchOperatorCloudAccessPermissions(req.operatorSession, accessId, { search })
        .catch(async (error) => {
          await log('warn', 'No se pudieron consultar PermisoAccesos en EOLO Cloud', {
            error: error.message,
            status: error.status,
            accessId
          });
          return null;
        });
      if (cloudPermissions) {
        const ensuredPermissions = await ensureOperatorCloudAccessPermissionsId2(
          req.operatorSession,
          cloudPermissions.permissions,
          accessId
        );
        const snapshot = await writeOperatorAccessPermissionsSnapshot(accessId, ensuredPermissions, {
          validAfter: cloudPermissions.validAfter,
          sourceCount: cloudPermissions.sourceCount,
          skippedExpired: cloudPermissions.skippedExpired
        });
        const snapshotPermissions = snapshot.permissions || [];
        const summary = summarizeOperatorAccessPermissions(snapshotPermissions);
        res.set('Cache-Control', 'no-store');
        res.json({
          ok: true,
          source: 'cloud',
          downloadedAt: snapshot.downloadedAt,
          validAfter: snapshot.validAfter,
          permissions: snapshotPermissions,
          total: snapshotPermissions.length,
          summary,
          sourceCount: snapshot.sourceCount,
          skippedExpired: snapshot.skippedExpired,
          schema: operatorAccessPermissionSchema()
        });
        return;
      }
    }

    const fallbackSnapshot = readOperatorAccessPermissionsSnapshot(accessId, search);
    const fallback = fallbackSnapshot?.permissions ||
      localFallbackAccessPermissions(accessId, search);
    const summary = summarizeOperatorAccessPermissions(fallback);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      source: fallbackSnapshot ? 'local-snapshot' : 'local-fallback',
      downloadedAt: fallbackSnapshot?.downloadedAt || null,
      permissions: fallback,
      total: fallback.length,
      summary,
      schema: operatorAccessPermissionSchema()
    });
  })
);

app.post(
  '/api/operator/access-permissions/id2',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.body.access || req.body.access_id || req.query.access || req.query.access_id || '').trim();
    const permissionId = String(req.body.permission || req.body.permission_id || req.body.permiso || '').trim();
    const tipoPermiso = String(req.body.tipo_permiso || req.body.permission_type || '').trim();
    const tipoEntidad = String(req.body.tipo_entidad || req.body.entity_type || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para generar ID2 de PermisoAccesos.');
      error.status = 400;
      throw error;
    }
    const result = await assignOperatorCloudAccessPermissionId2(req.operatorSession, {
      accessId,
      permissionId,
      tipoPermiso,
      tipoEntidad
    });
    res.json(result);
  })
);

app.put(
  '/api/operator/access-permissions/:id',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.body.access || req.body.access_id || req.query.access || req.query.access_id || '').trim();
    if (!accessId) {
      const error = new Error('El acceso es obligatorio para actualizar permisos.');
      error.status = 400;
      throw error;
    }
    const payload = normalizeOperatorAccessPermissionPatch(req.body, accessId);
    const updated = await patchOperatorDataItem(
      req.operatorSession,
      OPERATOR_ACCESS_PERMISSION_DATA_TYPE,
      req.params.id,
      payload
    );
    const normalized = normalizeOperatorAccessPermission(
      { ...updated, _id: req.params.id, ...payload },
      accessId
    );
    await mergeOperatorAccessPermissionSnapshot(accessId, normalized);
    res.json({
      ok: true,
      source: 'cloud-data-api',
      permission: normalized,
      raw: updated
    });
  })
);

app.get(
  '/api/operator/plate-history',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.query.access || req.query.access_id || '').trim();
    const plate = normalizePlateForLookup(req.query.plate || req.query.placa || '');
    if (!accessId || !plate) {
      const error = new Error('El acceso y la placa son obligatorios para consultar historial.');
      error.status = 400;
      throw error;
    }

    if (config.operator.authMode === 'cloud') {
      const profile = await fetchOperatorCloudPlateProfile(req.operatorSession, accessId, plate)
        .catch(async (error) => {
          await log('warn', 'No se pudo consultar historial de placa en EOLO Cloud', {
            error: error.message,
            status: error.status,
            accessId,
            plate
          });
          return null;
        });
      if (profile) {
        res.set('Cache-Control', 'no-store');
        res.json({
          ok: true,
          source: 'cloud',
          found: Boolean(
            profile.visitor_name ||
              profile.id_image ||
              hasOperatorVehicleDetails(profile.vehicle) ||
              profile.vehicle_id ||
              profile.driver_id ||
              profile.drivers?.length
          ),
          profile
        });
        return;
      }
    }

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, source: 'local-fallback', found: false, profile: null });
  })
);

app.post(
  '/api/operator/movements',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = String(req.body.access_id || req.body.access || req.body.id_acceso || '').trim();
    const controlPointId = String(
      req.body.control_point_id || req.body.control_point || req.body.id_punto_control || ''
    ).trim();
    if (config.operator.authMode === 'cloud') {
      if (!accessId || !controlPointId) {
        const error = new Error('El acceso y punto de control son obligatorios para crear movimientos.');
        error.status = 400;
        throw error;
      }
      const movementPayload = await ensureOperatorMovementLocalId2(req.body, accessId);
      const createdMovement = await createOperatorCloudMovement(
        req.operatorSession,
        movementPayload,
        accessId,
        controlPointId
      ).catch(async (error) => {
        if (!isRetryableOperatorCloudError(error)) throw error;
        const pending = await createPendingOperatorMovement(movementPayload, accessId, controlPointId, error);
        await log('warn', 'Movimiento de operador guardado localmente por EOLO Cloud inaccesible', {
          localId: pending.id,
          accessId,
          controlPointId,
          error: error.message
        });
        await recordOperatorMovementEvent(req, {
          payload: movementPayload,
          movement: pending.movement,
          accessId,
          controlPointId,
          source: 'local-pending'
        });
        res.status(202).json({
          ok: true,
          source: 'local-pending',
          pending: true,
          movement: pending.movement,
          movements: [pending.movement],
          pendingMovement: publicPendingOperatorMovement(pending)
        });
        return null;
      });
      if (!createdMovement) return;
      invalidateOperatorInventorySummary(accessId);
      await recordOperatorMovementEvent(req, {
        payload: movementPayload,
        movement: createdMovement,
        accessId,
        controlPointId,
        source: 'cloud'
      });
      res.status(201).json({
        ok: true,
        source: 'cloud',
        movement: createdMovement,
        movements: createdMovement ? [createdMovement] : []
      });
      return;
    }

    const localResult = await fetchAnprJson('/api/operator/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      timeoutMs: 12000
    });
    const localMovement = localResult?.movement || localResult?.movements?.[0] || localResult;
    await recordOperatorMovementEvent(req, {
      payload: req.body,
      movement: localMovement,
      accessId,
      controlPointId,
      source: localResult?.source || 'local'
    });
    res.status(201).json(localResult);
  })
);

app.patch(
  '/api/operator/movements/:id',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    if (config.operator.authMode === 'cloud') {
      const action = String(req.body.action || '').toLowerCase();
      if (action !== 'egress') {
        const error = new Error('Actualizacion cloud no soportada para este movimiento.');
        error.status = 400;
        throw error;
      }
      const updatedMovement = await egressOperatorCloudMovement(
        req.operatorSession,
        req.params.id,
        req.body
      );
      invalidateOperatorInventorySummary(String(req.body.access_id || req.body.access || '').trim());
      res.json({
        ok: true,
        source: 'cloud',
        movement: updatedMovement,
        movements: updatedMovement ? [updatedMovement] : []
      });
      return;
    }
    res.json(
      await fetchAnprJson(`/api/operator/movements/${encodeURIComponent(req.params.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: 12000
      })
    );
  })
);

app.get(
  '/api/operator/pending-movements',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    const pending = await loadPendingOperatorMovements();
    res.json({
      ok: true,
      pending: pending.map(publicPendingOperatorMovement),
      count: pending.length
    });
  })
);

app.get(
  '/api/operator/pending-movements/:id/photo',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const pending = await loadPendingOperatorMovements();
    const item = pending.find((movement) => movement.id === req.params.id);
    if (!item?.photoFile) {
      res.status(404).json({ ok: false, error: 'Fotografia pendiente no encontrada.' });
      return;
    }
    const filePath = pendingOperatorAssetPath(item.photoFile);
    res.type(item.photoMimeType || 'image/jpeg');
    res.sendFile(filePath);
  })
);

app.get(
  '/api/operator/pending-movements/:id/vehicle-photo',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const pending = await loadPendingOperatorMovements();
    const item = pending.find((movement) => movement.id === req.params.id);
    if (!item?.vehiclePhotoFile) {
      res.status(404).json({ ok: false, error: 'Fotografia del vehiculo pendiente no encontrada.' });
      return;
    }
    const filePath = pendingOperatorAssetPath(item.vehiclePhotoFile);
    res.type(item.vehiclePhotoMimeType || 'image/jpeg');
    res.sendFile(filePath);
  })
);

app.post(
  '/api/operator/pending-movements/sync',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const force = req.body?.force === true;
    const result = await syncPendingOperatorMovements(req.operatorSession, { force });
    for (const item of result.synced || []) {
      invalidateOperatorInventorySummary(item.accessId || item.movement?.accessId || item.movement?.access_id);
    }
    res.json({ ok: true, ...result });
  })
);

app.post(
  '/api/operator/sync',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const result = await fetchAnprJson('/api/sync_now', { method: 'POST', timeoutMs: 20000 });
    let deviceHeartbeat = null;
    const accessId = String(req.body?.access_id || req.body?.access || req.query?.access_id || '').trim();
    if (config.operator.deviceHeartbeatEnabled && config.operator.authMode === 'cloud') {
      try {
        deviceHeartbeat = await upsertOperatorCloudDeviceHeartbeat(req.operatorSession, { accessId });
      } catch (error) {
        deviceHeartbeat = {
          ok: false,
          error: error.message
        };
        await log('warn', 'No se pudo actualizar DispositivosAcceso en EOLO Cloud', {
          error: error.message,
          status: error.status,
          accessId
        });
      }
    }
    res.json({ ok: true, result, deviceHeartbeat, syncedAt: new Date().toISOString() });
  })
);

app.get(
  '/api/operator/vision-config',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = firstText(req.query.access, req.query.access_id);
    const keyContext = await resolveOpenAiVisionApiKey(req.operatorSession, accessId);
    res.json({
      ok: true,
      openaiVision: {
        ...publicRuntimeConfig().openaiVision,
        effectiveEnabled: Boolean(config.openaiVision.enabled || keyContext.accessKeySet),
        effectiveApiKeySet: Boolean(keyContext.apiKey),
        effectiveApiKeySource: keyContext.source,
        effectiveApiKeyLabel: keyContext.label,
        accessApiKeySet: keyContext.accessKeySet,
        localApiKeySet: keyContext.localKeySet,
        accessId: keyContext.accessId
      }
    });
  })
);

app.put(
  '/api/operator/vision-config',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const saved = await saveRuntimeConfig({
      openaiVision: req.body.openaiVision || req.body
    });
    await log('info', 'Configuracion OpenAI Vision guardada', {
      enabled: saved.openaiVision.enabled,
      apiKeySet: saved.openaiVision.apiKeySet,
      model: saved.openaiVision.model
    });
    res.json({ ok: true, openaiVision: saved.openaiVision });
  })
);

app.get(
  '/api/operator/cloud-config',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    res.json({ ok: true, operator: await publicOperatorCloudConfig() });
  })
);

app.put(
  '/api/operator/cloud-config',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const saved = await saveRuntimeConfig({
      operator: req.body.operator || req.body
    });
    await log('info', 'Configuracion EOLO Cloud operador guardada', {
      appBaseUrl: saved.operator.appBaseUrl,
      appVersion: saved.operator.appVersion,
      workflowBaseUrl: operatorWorkflowBaseUrl(),
      deviceIdSet: Boolean(saved.operator.deviceId)
    });
    res.json({ ok: true, operator: await publicOperatorCloudConfig() });
  })
);

app.get(
  '/api/operator/bridge-settings',
  requireOperatorSession,
  asyncRoute(async (_req, res) => {
    res.json({ ok: true, operator: await publicOperatorCloudConfig() });
  })
);

app.put(
  '/api/operator/bridge-settings',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const saved = await saveRuntimeConfig({
      operator: {
        serialNumber: firstText(body.serialNumber, body.sn)
      }
    });
    let deviceHeartbeat = null;
    const accessId = firstText(body.accessId, body.access_id, req.query.access, req.query.access_id);
    if (config.operator.deviceHeartbeatEnabled && config.operator.authMode === 'cloud') {
      try {
        deviceHeartbeat = await upsertOperatorCloudDeviceHeartbeat(req.operatorSession, { accessId });
      } catch (error) {
        deviceHeartbeat = {
          ok: false,
          error: error.message,
          status: error.status
        };
        await log('warn', 'No se pudo reflejar SN del Bridge en EOLO Cloud', {
          error: error.message,
          status: error.status,
          accessId
        });
      }
    }
    await log('info', 'Ajustes Bridge guardados', {
      deviceId: await operatorBridgeDeviceId(),
      sn: saved.operator.serialNumber,
      cloudUpdated: Boolean(deviceHeartbeat?.ok)
    });
    res.json({
      ok: true,
      operator: await publicOperatorCloudConfig(),
      deviceHeartbeat
    });
  })
);

app.post(
  '/api/operator/identification/extract-name',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const accessId = firstText(req.body.access_id, req.body.access, req.query.access_id, req.query.access);
    const keyContext = await resolveOpenAiVisionApiKey(req.operatorSession, accessId);
    if (!config.openaiVision.enabled && !keyContext.accessKeySet) {
      res.json({ ok: true, enabled: false, extracted: false, message: 'OpenAI Vision esta deshabilitado.' });
      return;
    }
    if (!keyContext.apiKey) {
      const error = new Error('OpenAI Vision no tiene API key configurada.');
      error.status = 400;
      throw error;
    }
    const imageDataUrl = String(req.body.imageDataUrl || req.body.id_photo_data_url || '').trim();
    const image = parseDataUrl(imageDataUrl);
    if (!image) {
      const error = new Error('La fotografia de identificacion no tiene un formato valido.');
      error.status = 400;
      throw error;
    }
    const startedAt = Date.now();
    const result = await extractIdentificationName(imageDataUrl, { apiKey: keyContext.apiKey });
    await log(result.fullName ? 'info' : 'warn', 'Lectura OpenAI Vision de identificacion completada', {
      extracted: Boolean(result.fullName),
      confidence: result.confidence,
      model: config.openaiVision.model,
      keySource: keyContext.source,
      accessId,
      latencyMs: Date.now() - startedAt
    });
    res.json({
      ok: true,
      enabled: true,
      apiKeySource: keyContext.source,
      apiKeyLabel: keyContext.label,
      extracted: Boolean(result.fullName),
      ...result
    });
  })
);

app.get(
  '/api/operator/login-status',
  asyncRoute(async (_req, res) => {
    const checkedAt = new Date().toISOString();
    const [cloud, anpr] = await Promise.all([checkOperatorCloudAlive(), checkAnprAlive()]);
    res.json({
      ok: true,
      checkedAt,
      operator: await publicOperatorCloudConfig(),
      bridge: {
        online: true,
        checkedAt
      },
      cloud,
      anpr
    });
  })
);

app.get(
  '/api/operator/cloud-status',
  requireOperatorSession,
  asyncRoute(async (req, res) => {
    const checkedAt = new Date().toISOString();
    if (config.operator.authMode !== 'cloud') {
      res.json({
        ok: true,
        online: false,
        configured: false,
        checkedAt,
        message: 'El operador esta en modo local; no hay sesion EOLO Cloud para validar.'
      });
      return;
    }
    const startedAt = Date.now();
    try {
      const cloud = await fetchOperatorCloudPing(req.operatorSession);
      res.json({
        ok: true,
        online: true,
        configured: true,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        cloud
      });
    } catch (error) {
      await log('warn', 'Ping EOLO Cloud de operador fallido', {
        error: error.message,
        status: error.status,
        endpoint: config.operator.cloudStatusEndpoint
      });
      res.json({
        ok: true,
        online: false,
        configured: true,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: error.message
      });
    }
  })
);

app.get('/api/events', (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit || '500', 10) || 500, 2000);
  const search = normalizeSearchText(req.query.search || '');
  const objectType = String(req.query.object_type || '').toLowerCase();
  const startDate = parseEventBoundary(req.query.start, 'start');
  const endDate = parseEventBoundary(req.query.end, 'end');
  const events = readLocalEventHistory()
    .map(normalizeLocalEvent)
    .filter((event) => {
      const eventTime = parseOperatorDateValue(event.timestamp);
      if (startDate && (!eventTime || eventTime < startDate)) return false;
      if (endDate && (!eventTime || eventTime > endDate)) return false;
      if (objectType === 'vehicle' && !event.hasVehicle) return false;
      if (objectType === 'person' && !event.hasPerson) return false;
      if (search) {
        const haystack = normalizeSearchText([
          event.type,
          event.objectType,
          event.identifiedValue,
          event.camera,
          event.device,
          event.detail,
          event.rawText
        ].join(' '));
        if (!haystack.includes(search)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const bDate = parseOperatorDateValue(b.timestamp);
      const aDate = parseOperatorDateValue(a.timestamp);
      return (bDate?.getTime() || 0) - (aDate?.getTime() || 0);
    });
  const summary = summarizeLocalEvents(events);
  res.json({
    ok: true,
    source: 'local',
    events: events.slice(0, limit),
    total: events.length,
    summary
  });
});

app.get('/api/logs', asyncRoute(async (req, res) => {
  const limit = Number.parseInt(req.query.limit || '100', 10);
  res.json({ logs: await getStoredLogs(limit) });
}));

app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send('snapshot', {
    events: getEvents(50).reverse(),
    logs: getLogs(50).reverse()
  });

  const eventListener = (event) => send('device-event', event);
  const logListener = (record) => send('log', record);
  bus.on('event', eventListener);
  bus.on('log', logListener);

  req.on('close', () => {
    bus.off('event', eventListener);
    bus.off('log', logListener);
  });
});

app.post(
  '/api/device/stream/start',
  asyncRoute(async (_req, res) => {
    res.json({ ok: true, ...(await startDeviceEventService()) });
  })
);

app.post(
  '/api/device/stream/stop',
  asyncRoute(async (_req, res) => {
    res.json({ ok: true, ...(await stopDeviceEventService()) });
  })
);

app.post(
  '/api/mock/event',
  asyncRoute(async (req, res) => {
    if (!config.mockDevice) {
      res.status(404).json({ ok: false, error: 'Disponible solo con MOCK_DEVICE=true' });
      return;
    }
    const event = await device.emitRecognition(req.body.employeeNo, req.body.name);
    res.json({ ok: true, event });
  })
);

app.get('*', (_req, res) => {
  res.redirect(302, '/');
});

app.use((error, _req, res, _next) => {
  log('error', 'Error en solicitud HTTP', {
    error: error.message,
    status: error.status,
    body: error.body,
    upstream: error.upstream
  }).catch(() => {});
  res.status(error.status || 500).json({
    ok: false,
    error: error.message,
    detail: error.body,
    upstream: error.upstream
  });
});

const server = app.listen(config.port, () => {
  log('info', `Servicio EOLO Access Bridge escuchando en puerto ${config.port}`, {
    mode: config.mockDevice ? 'mock' : 'device'
  }).catch(() => {});
  taskRunner.startPolling();
  eoloUserSync.start();
  if (config.anpr.webrtcEnabled && config.anpr.webrtcAutostart) {
    startGo2rtcPreview().catch((error) => {
      log('warn', 'No se pudo iniciar WebRTC automaticamente', { error: error.message }).catch(
        () => {}
      );
      scheduleGo2rtcWatchdog();
    });
  }
  restoreDesiredFaceDeviceStreams().catch((error) => {
    log('warn', 'No se pudieron restaurar streams faciales automaticamente', {
      error: error.message
    }).catch(() => {});
  });
});

const shutdown = () => {
  shutdownRequested = true;
  taskRunner.stopPolling();
  eoloUserSync.stop();
  stopGo2rtcPreview().catch(() => {});
  if (eventStream?.running) eventStream.stop();
  stopAllFaceDeviceStreams();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function normalizeEmployee(body) {
  if (!body.employeeNo) {
    const error = new Error('employeeNo es obligatorio');
    error.status = 400;
    throw error;
  }
  return {
    employeeNo: String(body.employeeNo).trim(),
    name: String(body.name || `Empleado ${body.employeeNo}`).trim(),
    userType: body.userType || 'normal',
    beginTime: body.beginTime || undefined,
    endTime: body.endTime || undefined,
    enable: body.enable !== false,
    doorNo: body.doorNo || activeFaceDeviceSettings().doorNo,
    planTemplateNo: body.planTemplateNo || activeFaceDeviceSettings().planTemplateNo
  };
}

function registerServices() {
  serviceManager.register({
    id: 'pedestrians',
    name: 'Peatones',
    group: 'bridge',
    description: 'Administra servicios y dispositivos locales para reconocimiento y permisos peatonales.',
    controllable: false,
    status: async () => {
      const running = config.faceDevices.filter((item) => faceDeviceStreams.get(item.id)?.running).length;
      return {
        running: running > 0,
        status: running > 0 ? 'running' : 'stopped',
        totalDevices: config.faceDevices.length,
        runningDevices: running
      };
    }
  });

  serviceManager.register({
    id: 'vehicles',
    name: 'Vehiculos',
    group: 'bridge',
    description: 'Administra servicios y dispositivos locales para reconocimiento, registro y permisos vehiculares.',
    controllable: false,
    status: async () => {
      try {
        const [hardware, services] = await Promise.all([
          fetchAnprJson('/api/hardware', { timeoutMs: 5000 }).catch(() => ({ cameras: [] })),
          fetchAnprJson('/api/services', { timeoutMs: 5000 }).catch(() => ({ services: [] }))
        ]);
        const processor = services.services?.find((item) => item.id === 'anpr-processor') || {};
        const cameras = Array.isArray(hardware.cameras) ? hardware.cameras : [];
        const rtspStreams = processor.running
          ? cameras.filter((camera) => camera.rtsp || camera.rtsp_url || camera.has_rtsp).length
          : 0;
        return {
          running: rtspStreams > 0,
          status: rtspStreams > 0 ? 'running' : 'stopped',
          totalDevices: cameras.length,
          rtspStreams
        };
      } catch (error) {
        return { running: false, status: 'unreachable', error: error.message };
      }
    }
  });

  serviceManager.register({
    id: 'hikvision-events',
    name: 'Reconocimiento Facial',
    group: 'bridge',
    description: 'Opera reconocimiento facial local y eventos del dispositivo activo.',
    status: async () => {
      const running = config.mockDevice ? Boolean(device.interval) : Boolean(eventStream?.running);
      return {
        running,
        status: running ? 'running' : 'stopped',
        mode: config.mockDevice ? 'mock' : config.faceDevice
      };
    },
    start: startDeviceEventService,
    stop: stopDeviceEventService
  });

  serviceManager.register({
    id: 'face-devices',
    name: 'Dispositivos Faciales',
    group: 'bridge',
    description: 'Administra multiples terminales Dahua/Hikvision y sus streams locales.',
    controllable: false,
    status: async () => {
      const running = config.faceDevices.filter((item) => faceDeviceStreams.get(item.id)?.running).length;
      return {
        running: running > 0,
        status: running > 0 ? 'running' : 'stopped',
        total: config.faceDevices.length,
        runningDevices: running
      };
    }
  });

  serviceManager.register({
    id: 'eolo-users-sync',
    name: 'Residentes Sync',
    group: 'bridge',
    description: 'Sincroniza permisos/residentes EOLO hacia todos los dispositivos faciales habilitados y probados.',
    status: async () => ({
      ...eoloUserSync.status(),
      running: Boolean(eoloUserSync.timer || eoloUserSync.running),
      status: eoloUserSync.timer || eoloUserSync.running ? 'running' : 'stopped'
    }),
    start: async () => {
      if (!config.eolo.userSyncEnabled) {
        const error = new Error('Activa la sincronizacion EOLO en Configuracion antes de iniciar.');
        error.status = 400;
        throw error;
      }
      eoloUserSync.start();
    },
    stop: async () => eoloUserSync.stop(),
    restart: async () => eoloUserSync.restart()
  });

  serviceManager.register({
    id: 'eolo-task-poller',
    name: 'Tareas Pooling',
    group: 'bridge',
    description: 'Consulta tareas remotas pendientes para el dispositivo local.',
    status: async () => ({
      enabled: config.eolo.pollEnabled,
      running: Boolean(taskRunner.pollTimer),
      status: taskRunner.pollTimer ? 'running' : 'stopped'
    }),
    start: async () => {
      if (!config.eolo.pollEnabled) {
        const error = new Error('Activa EOLO_POLL_ENABLED antes de iniciar el polling.');
        error.status = 400;
        throw error;
      }
      taskRunner.startPolling();
    },
    stop: async () => taskRunner.stopPolling(),
    restart: async () => {
      taskRunner.stopPolling();
      taskRunner.startPolling();
    }
  });

  serviceManager.register({
    id: 'anpr-api',
    name: 'Local API ANPR',
    group: 'anpr',
    description: 'API interna Python para configuracion, visitas y control ANPR.',
    controllable: false,
    status: async () => {
      try {
        const response = await fetch(`${config.anpr.baseUrl}/api/health`, {
          signal: AbortSignal.timeout(3000)
        });
        const payload = await response.json().catch(() => ({}));
        return {
          running: response.ok,
          status: response.ok ? 'running' : 'error',
          port: payload.port,
          error: response.ok ? undefined : response.statusText
        };
      } catch (error) {
        return { running: false, status: 'unreachable', error: error.message };
      }
    }
  });

  serviceManager.register(
    remoteAnprService({
      id: 'anpr-processor',
      name: 'Procesador ANPR',
      baseUrl: config.anpr.baseUrl,
      description: 'Captura RTSP, detecta placas y registra movimientos locales.'
    })
  );
  serviceManager.register({
    id: 'barriers',
    name: 'Puertas y Barreras',
    group: 'anpr',
    description: 'Configura puertas y barreras disponibles para apertura local y activacion desde ANPR.',
    controllable: false,
    status: async () => {
      try {
        const hardware = await fetchAnprJson('/api/hardware', { timeoutMs: 5000 }).catch(() => ({ cameras: [], barriers: [] }));
        const cameras = Array.isArray(hardware.cameras) ? hardware.cameras : [];
        const barriers = Array.isArray(hardware.barriers) ? hardware.barriers : [];
        const linkedIds = new Set();
        cameras.forEach((camera) => {
          (Array.isArray(camera.barrier_ids) ? camera.barrier_ids : []).forEach((id) => {
            if (id) linkedIds.add(id);
          });
        });
        const associated = barriers.filter((barrier) => {
          const id = barrier.id_barra || barrier.id || barrier.numero_barra || '';
          if (id && linkedIds.has(id)) return true;
          return Boolean(barrier.camera_name && cameras.some((camera) => camera.name === barrier.camera_name));
        }).length;
        return {
          running: associated > 0,
          status: associated > 0 ? 'associated' : 'unlinked',
          totalDevices: barriers.length,
          associated
        };
      } catch (error) {
        return { running: false, status: 'unreachable', error: error.message };
      }
    }
  });
  serviceManager.register({
    id: 'identification-reader',
    name: 'Lectura de Identificaciones',
    group: 'bridge',
    description: 'Configura camara local y OpenAI Vision para lectura de identificaciones.',
    controllable: false,
    status: async () => {
      const running = Boolean(config.openaiVision.enabled && config.openaiVision.apiKey);
      return {
        running,
        status: running ? 'configured' : 'pending',
        model: config.openaiVision.model,
        apiKeySet: Boolean(config.openaiVision.apiKey)
      };
    }
  });
  serviceManager.register({
    id: 'cloud-sync',
    name: 'Sincronizacion',
    group: 'bridge',
    description: 'Configura Cloud, descarga de permisos y carga automatica a dispositivos locales.',
    controllable: false,
    status: async () => ({
      running: Boolean(config.operator.appBaseUrl),
      status: config.operator.appBaseUrl ? 'configured' : 'pending',
      appBaseUrl: config.operator.appBaseUrl,
      appVersion: config.operator.appVersion,
      deviceHeartbeatEnabled: config.operator.deviceHeartbeatEnabled
    })
  });
  serviceManager.register({
    id: 'bridge-settings',
    name: 'Ajustes Bridge',
    group: 'bridge',
    description: 'Configura el identificador operativo y SN del Bridge local.',
    controllable: false,
    status: async () => ({
      running: true,
      status: 'configured',
      deviceId: await operatorBridgeDeviceId(),
      serialNumber: operatorBridgeSerial()
    })
  });
  serviceManager.register({
    id: 'webrtc-preview',
    name: 'Visualizador RTC',
    group: 'anpr',
    description: 'Proxy ligero go2rtc para video RTSP de baja latencia en navegador.',
    status: async () => {
      const status = go2rtcStatus();
      if (!status.running && (await isGo2rtcReachable())) {
        return { ...status, running: true, status: 'running-external' };
      }
      return status;
    },
    start: startGo2rtcPreview,
    stop: stopGo2rtcPreview,
    restart: async () => {
      await stopGo2rtcPreview();
      return startGo2rtcPreview();
    }
  });
  serviceManager.register(
    remoteAnprService({
      id: 'visit-sync',
      name: 'Visitas Sync',
      baseUrl: config.anpr.baseUrl,
      description: 'Sincroniza accesos y visitas locales hacia EOLO Cloud.'
    })
  );
}

function normalizeEmployeeSearch(result) {
  const search = result.UserInfoSearch || result.UserInfoSearchCond || result;
  const employees = search.UserInfo || search.userInfo || search.UserInfoList || [];
  const list = Array.isArray(employees) ? employees : [employees].filter(Boolean);
  return {
    employees: list.map(sanitizeEmployee),
    totalMatches: Number(search.totalMatches ?? search.numOfMatches ?? list.length ?? 0),
    numOfMatches: Number(search.numOfMatches ?? list.length ?? 0),
    responseStatus: search.responseStatusStrg || search.statusString || result.statusString || 'OK'
  };
}

function sanitizeEmployee(employee) {
  const { password, ...safeEmployee } = employee;
  return safeEmployee;
}

function createDevice() {
  if (config.mockDevice) return new MockDevice();
  if (config.faceDevice === 'dahua') return new DahuaClient(config.dahua);
  return new HikvisionClient(config.hikvision);
}

function createEventStream() {
  if (config.mockDevice) return null;
  if (config.faceDevice === 'dahua') {
    return new DahuaEventStream(device, eoloClient, {
      onAccessEvent: handleFacialAccessEvent
    });
  }
  return new DeviceEventStream(device, eoloClient, {
    onAccessEvent: handleFacialAccessEvent
  });
}

function createFaceDeviceClient(faceDevice) {
  if (config.mockDevice) return new MockDevice();
  const settings = faceDeviceSettingsForClient(faceDevice);
  if (faceDevice.type === 'dahua') return new DahuaClient(settings);
  return new HikvisionClient(settings);
}

function createFaceDeviceStream(faceDevice) {
  if (config.mockDevice) return null;
  const client = createFaceDeviceClient(faceDevice);
  const options = { onAccessEvent: handleFacialAccessEvent };
  return faceDevice.type === 'dahua'
    ? new DahuaEventStream(client, eoloClient, options)
    : new DeviceEventStream(client, eoloClient, options);
}

function faceDeviceSettingsForClient(faceDevice) {
  return {
    ...faceDevice,
    bridgeIdentifier: faceDevice.bridgeIdentifier || faceDevice.name,
    dedupWindowMs: Number(faceDevice.dedupWindowSeconds || 8) * 1000
  };
}

function findFaceDevice(deviceId) {
  const target = config.faceDevices.find((item) => item.id === deviceId);
  if (!target) {
    const error = new Error('Dispositivo facial no encontrado');
    error.status = 404;
    throw error;
  }
  return target;
}

function publicFaceDevice(faceDevice) {
  const { password, ...safeDevice } = faceDevice;
  return {
    ...safeDevice,
    passwordSet: Boolean(password),
    streamDesired: Boolean(faceDevice.streamDesired),
    stream: faceDeviceStreams.get(faceDevice.id)?.status() || {
      running: false,
      device: faceDevice.type,
      deviceId: faceDevice.id
    }
  };
}

function faceDevicesWithStatus() {
  return config.faceDevices.map(publicFaceDevice);
}

function eligibleFaceDevices() {
  return config.faceDevices.filter((device) => device.enabled && device.lastTestOk);
}

function ensureFaceDeviceSyncEligible(faceDevice) {
  if (!faceDevice.enabled) {
    const error = new Error('El dispositivo facial no esta habilitado para sincronizacion.');
    error.status = 400;
    throw error;
  }
  if (!faceDevice.lastTestOk) {
    const error = new Error('Prueba correctamente la comunicacion del dispositivo antes de sincronizar.');
    error.status = 400;
    throw error;
  }
}

async function persistFaceDevices(nextDevices) {
  await saveRuntimeConfig({
    mockDevice: config.mockDevice,
    faceDevice: config.faceDevice,
    hikvision: config.hikvision,
    dahua: config.dahua,
    faceDevices: nextDevices,
    eolo: config.eolo,
    openaiVision: config.openaiVision,
    operator: config.operator
  });
}

function faceDeviceConnectionSignature(faceDevice = {}) {
  return JSON.stringify({
    type: faceDevice.type,
    protocol: faceDevice.protocol,
    host: faceDevice.host,
    port: Number(faceDevice.port || 80),
    username: faceDevice.username,
    localDeviceId: faceDevice.localDeviceId || '',
    doorNo: Number(faceDevice.doorNo ?? 0)
  });
}

async function updateFaceDeviceTestState(deviceId, result) {
  const nextDevices = config.faceDevices.map((device) =>
    device.id === deviceId
      ? {
        ...device,
        lastTestOk: Boolean(result.ok),
        lastTestAt: new Date().toISOString(),
        lastTestMessage: result.message || (result.ok ? 'Respuesta valida.' : 'Prueba fallida.'),
        lastTestStatus: result.status ? String(result.status) : '',
        lastTestTarget: result.target || ''
      }
      : device
  );
  await persistFaceDevices(nextDevices);
}

async function runEoloUserSyncForEligibleFaceDevices(options = {}) {
  if (eoloUserSync.running) {
    return { ok: true, skipped: true, reason: 'sync-running' };
  }
  eoloUserSync.running = true;
  eoloUserSync.lastError = null;
  const startedAt = new Date().toISOString();
  try {
    const tokenContext = resolveEoloUserSyncToken({
      ...options,
      allowSavedConfigFallback: !options.scheduled
    });
    if (!tokenContext.token) {
      const error = new Error(
        options.scheduled
          ? 'No hay una sesion EOLO activa para ejecutar la sincronizacion automatica de usuarios.'
          : 'No hay token EOLO disponible para sincronizar usuarios.'
      );
      error.status = 401;
      error.tokenSource = tokenContext.source;
      throw error;
    }
    const cloud = await downloadEoloSnapshotFromOperatorPermissions({
      ...options,
      token: tokenContext.token,
      userId: tokenContext.userId,
      tokenSource: tokenContext.source,
      accessId: config.eolo.access,
      allowWhileFullRunning: true
    });
    const device = await applySnapshotToEligibleFaceDevices({ allowWhileFullRunning: true });
    const result = {
      ok: device.ok,
      startedAt,
      completedAt: new Date().toISOString(),
      cloud,
      device,
      cloudCount: cloud.cloudCount,
      validCloudCount: cloud.validCloudCount,
      skippedInvalid: cloud.skippedInvalid,
      targetCount: device.targetCount,
      successCount: device.successCount,
      failedCount: device.failedCount,
      results: device.results,
      tokenSource: tokenContext.source,
      operatorUserId: tokenContext.userId || ''
    };
    eoloUserSync.lastRunAt = result.completedAt;
    eoloUserSync.lastResult = result;
    await log(result.ok ? 'info' : 'warn', 'Sincronizacion EOLO multi-dispositivo completada', result);
    return result;
  } catch (error) {
    eoloUserSync.lastRunAt = new Date().toISOString();
    eoloUserSync.lastError = error.message;
    throw error;
  } finally {
    eoloUserSync.running = false;
  }
}

async function downloadEoloSnapshotFromOperatorPermissions(options = {}) {
  if (eoloUserSync.cloudRunning || (eoloUserSync.running && !options.allowWhileFullRunning)) {
    return { ok: true, skipped: true, reason: 'cloud-sync-running' };
  }
  const accessId = String(options.accessId || config.eolo.access || '').trim();
  if (!accessId) {
    const error = new Error('Configura el acceso activo antes de descargar PermisoAccesos.');
    error.status = 400;
    throw error;
  }
  const token = String(options.token || '').trim();
  if (!token) {
    const error = new Error('No hay token EOLO disponible para descargar PermisoAccesos.');
    error.status = 401;
    error.tokenSource = options.tokenSource || 'missing';
    throw error;
  }

  eoloUserSync.cloudRunning = true;
  eoloUserSync.lastCloudError = null;
  const startedAt = new Date().toISOString();
  try {
    await log('info', 'Descargando PermisoAccesos EOLO desde Cloud', {
      accessId,
      sourceType: OPERATOR_ACCESS_PERMISSION_DATA_TYPE,
      tokenSource: options.tokenSource || 'unknown'
    });
    const session = { token, userId: options.userId || '' };
    const cloudPermissions = await fetchOperatorCloudAccessPermissions(session, accessId);
    const ensuredPermissions = await ensureOperatorCloudAccessPermissionsId2(
      session,
      cloudPermissions.permissions,
      accessId
    );
    const snapshot = await writeOperatorAccessPermissionsSnapshot(accessId, ensuredPermissions, {
      validAfter: cloudPermissions.validAfter,
      sourceCount: cloudPermissions.sourceCount,
      skippedExpired: cloudPermissions.skippedExpired
    });
    const permissions = snapshot.permissions || [];
    const employees = operatorAccessPermissionsToDeviceEmployees(permissions);
    const result = {
      ok: true,
      step: 'cloud',
      sourceType: OPERATOR_ACCESS_PERMISSION_DATA_TYPE,
      access: accessId,
      endpoint: operatorDataUrl(OPERATOR_ACCESS_PERMISSION_DATA_TYPE),
      validAfter: snapshot.validAfter,
      startedAt,
      completedAt: new Date().toISOString(),
      cloudCount: permissions.length,
      sourceCount: snapshot.sourceCount,
      validCloudCount: employees.length,
      skippedInvalid: 0,
      skippedExpired: snapshot.skippedExpired,
      skippedForDeviceCount: permissions.length - employees.length,
      snapshotFile: path.basename(eoloUserSync.snapshotPath),
      permissionSnapshotFile: path.basename(operatorAccessPermissionsSnapshotPath()),
      permissionsSummary: summarizeOperatorAccessPermissions(permissions),
      tokenSource: options.tokenSource || 'unknown',
      operatorUserId: options.userId || ''
    };
    await eoloUserSync.writeCloudSnapshot({ permissions, employees, result });
    eoloUserSync.lastCloudRunAt = result.completedAt;
    eoloUserSync.lastCloudResult = result;
    await log('info', 'Descarga de PermisoAccesos EOLO completada', result);
    return {
      ...result,
      permissions,
      summary: result.permissionsSummary
    };
  } catch (error) {
    eoloUserSync.lastCloudRunAt = new Date().toISOString();
    eoloUserSync.lastCloudError = error.message;
    throw error;
  } finally {
    eoloUserSync.cloudRunning = false;
  }
}

async function applySnapshotToEligibleFaceDevices(options = {}) {
  if (eoloUserSync.deviceRunning || (eoloUserSync.running && !options.allowWhileFullRunning)) {
    return { ok: true, skipped: true, reason: 'device-sync-running' };
  }

  const targets = eligibleFaceDevices();
  if (!targets.length) {
    const result = {
      ok: false,
      step: 'device',
      skipped: true,
      reason: 'no-eligible-face-devices',
      message: 'No hay dispositivos faciales habilitados y probados para sincronizar.',
      targetCount: 0,
      successCount: 0,
      failedCount: 0,
      results: []
    };
    eoloUserSync.lastDeviceRunAt = new Date().toISOString();
    eoloUserSync.lastDeviceResult = result;
    eoloUserSync.lastDeviceError = result.message;
    return result;
  }

  eoloUserSync.deviceRunning = true;
  eoloUserSync.lastDeviceError = null;
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    for (const target of targets) {
      const sync = new EoloUserSync(createFaceDeviceClient(target), eoloClient);
      try {
        const result = await sync.applySnapshotToDevice({ allowWhileFullRunning: true });
        results.push({
          ok: true,
          deviceId: target.id,
          type: target.type,
          name: target.name,
          host: target.host,
          result
        });
      } catch (error) {
        results.push({
          ok: false,
          deviceId: target.id,
          type: target.type,
          name: target.name,
          host: target.host,
          error: error.message
        });
      }
    }
    const successCount = results.filter((item) => item.ok).length;
    const failedCount = results.length - successCount;
    const result = {
      ok: failedCount === 0,
      step: 'device',
      startedAt,
      completedAt: new Date().toISOString(),
      targetCount: targets.length,
      successCount,
      failedCount,
      results
    };
    eoloUserSync.lastDeviceRunAt = result.completedAt;
    eoloUserSync.lastDeviceResult = result;
    eoloUserSync.lastDeviceError = result.ok ? null : `${failedCount} dispositivo(s) fallaron.`;
    await log(result.ok ? 'info' : 'warn', 'Carga de snapshot EOLO a dispositivos faciales completada', result);
    return result;
  } finally {
    eoloUserSync.deviceRunning = false;
  }
}

function normalizeFaceDeviceInput(input = {}, existing = {}) {
  const type = ['hikvision', 'dahua'].includes(String(input.type || existing.type || '').toLowerCase())
    ? String(input.type || existing.type).toLowerCase()
    : 'hikvision';
  const host = String(input.host ?? existing.host ?? '').trim();
  const username = String(input.username ?? existing.username ?? '').trim();
  if (!host) {
    const error = new Error('La IP o host del dispositivo facial es obligatorio');
    error.status = 400;
    throw error;
  }
  if (!username) {
    const error = new Error('El usuario del dispositivo facial es obligatorio');
    error.status = 400;
    throw error;
  }
  const protocol = String(input.protocol || existing.protocol || 'http').toLowerCase();
  if (!['http', 'https'].includes(protocol)) {
    const error = new Error('El protocolo debe ser http o https');
    error.status = 400;
    throw error;
  }
  const fallbackName = type === 'dahua' ? 'Dahua ASI' : 'Hikvision Mini Moe';
  return {
    id: existing.id,
    type,
    enabled: input.enabled === undefined ? Boolean(existing.enabled) : Boolean(input.enabled),
    name: String(input.name || existing.name || fallbackName).trim(),
    bridgeIdentifier: String(input.bridgeIdentifier || existing.bridgeIdentifier || input.name || fallbackName).trim(),
    localDeviceId: String(input.localDeviceId ?? existing.localDeviceId ?? '').trim(),
    controlPointId: String(input.controlPointId ?? input.control_point_id ?? existing.controlPointId ?? '').trim(),
    controlPointName: String(input.controlPointName ?? input.control_point_name ?? existing.controlPointName ?? '').trim(),
    protocol,
    host,
    port: intInRange(input.port, existing.port || 80, 1, 65535),
    username,
    password: input.password === '' ? existing.password || '' : String(input.password ?? existing.password ?? ''),
    doorNo: intInRange(input.doorNo, existing.doorNo ?? (type === 'dahua' ? 0 : 1), type === 'dahua' ? 0 : 1, 128),
    planTemplateNo: String(input.planTemplateNo || existing.planTemplateNo || '1'),
    fdid: String(input.fdid || existing.fdid || '1'),
    faceLibType: String(input.faceLibType || existing.faceLibType || 'blackFD'),
    cardType: intInRange(input.cardType, existing.cardType ?? 0, 0, 255),
    validYears: intInRange(input.validYears, existing.validYears || 10, 1, 50),
    dedupWindowSeconds: intInRange(input.dedupWindowSeconds, existing.dedupWindowSeconds || 8, 1, 120),
    eventCodes: String(input.eventCodes ?? existing.eventCodes ?? 'All').trim() || 'All',
    heartbeatSeconds: intInRange(input.heartbeatSeconds, existing.heartbeatSeconds || 5, 1, 60),
    streamDesired: Boolean(input.streamDesired ?? existing.streamDesired)
  };
}

async function validateFaceDevice(faceDevice) {
  return validateDeviceConfig({
    faceDevice: faceDevice.type,
    [faceDevice.type]: faceDeviceSettingsForClient(faceDevice)
  }, false);
}

async function startFaceDeviceStream(faceDevice) {
  if (config.mockDevice) {
    const error = new Error('Los streams multiples requieren modo dispositivo real.');
    error.status = 400;
    throw error;
  }
  const existing = faceDeviceStreams.get(faceDevice.id);
  if (existing?.running) return existing.status();
  const stream = createFaceDeviceStream(faceDevice);
  faceDeviceStreams.set(faceDevice.id, stream);
  return stream.start();
}

async function stopFaceDeviceStream(deviceId) {
  const stream = faceDeviceStreams.get(deviceId);
  if (!stream) return { running: false, deviceId };
  const result = stream.stop();
  faceDeviceStreams.delete(deviceId);
  return result;
}

async function setFaceDeviceStreamDesired(deviceId, desired) {
  await persistFaceDevices(
    config.faceDevices.map((device) =>
      device.id === deviceId ? { ...device, streamDesired: Boolean(desired) } : device
    )
  );
}

async function restoreDesiredFaceDeviceStreams() {
  const targets = config.faceDevices.filter(
    (device) => device.enabled && device.lastTestOk && device.streamDesired
  );
  if (!targets.length) return;
  const results = [];
  for (const target of targets) {
    try {
      results.push({ deviceId: target.id, ok: true, result: await startFaceDeviceStream(target) });
    } catch (error) {
      results.push({ deviceId: target.id, ok: false, error: error.message });
    }
  }
  await log(results.every((item) => item.ok) ? 'info' : 'warn', 'Streams faciales restaurados al iniciar Bridge', {
    targetCount: targets.length,
    successCount: results.filter((item) => item.ok).length,
    failedCount: results.filter((item) => !item.ok).length,
    results
  });
}

function stopAllFaceDeviceStreams() {
  for (const deviceId of faceDeviceStreams.keys()) {
    stopFaceDeviceStream(deviceId).catch(() => {});
  }
}

function rebuildDeviceClients() {
  eoloClient.enabled = Boolean(config.eolo.baseUrl);
  device = createDevice();
  eventStream = createEventStream();
  taskRunner.device = device;
  eoloUserSync.device = device;
  eoloUserSync.runHandler = runEoloUserSyncForEligibleFaceDevices;
}

function getOperatorToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return '';
}

function rememberOperatorCloudSession(session) {
  if (!session?.token || !session?.userId) return;
  latestOperatorCloudSession = {
    token: session.token,
    userId: session.userId,
    expiresAt: session.expiresAt || null,
    operator: session.operator || null,
    updatedAt: new Date().toISOString()
  };
}

function forgetOperatorCloudSession(token) {
  if (token && latestOperatorCloudSession?.token === token) {
    latestOperatorCloudSession = null;
  }
}

function activeOperatorCloudSession() {
  if (!latestOperatorCloudSession?.token) return null;
  if (
    latestOperatorCloudSession.expiresAt &&
    Date.parse(latestOperatorCloudSession.expiresAt) <= Date.now()
  ) {
    latestOperatorCloudSession = null;
    return null;
  }
  return latestOperatorCloudSession;
}

function operatorAccessVisionCacheKey(session, accessId) {
  return `${session?.token || ''}:${session?.userId || ''}:${accessId || ''}`;
}

function rememberOperatorAccessVisionKeys(session, accesses = []) {
  if (!session?.token) return;
  for (const access of accesses) {
    if (!access?.id) continue;
    const key = firstText(access.accessOpenaiApiKey);
    const cacheKey = operatorAccessVisionCacheKey(session, access.id);
    if (key) {
      operatorAccessVisionKeyCache.set(cacheKey, {
        accessId: access.id,
        apiKey: key,
        updatedAt: new Date().toISOString()
      });
    } else {
      operatorAccessVisionKeyCache.delete(cacheKey);
    }
  }
}

async function resolveOpenAiVisionApiKey(session, accessId = '') {
  const accessKey = accessId
    ? firstText(operatorAccessVisionKeyCache.get(operatorAccessVisionCacheKey(session, accessId))?.apiKey)
    : '';
  if (accessKey) {
    return {
      apiKey: accessKey,
      source: 'access',
      label: 'Acceso',
      accessId,
      accessKeySet: true,
      localKeySet: Boolean(config.openaiVision.apiKey)
    };
  }
  if (session?.token && accessId) {
    const access = await fetchOperatorDataItem(session, 'accesos', accessId)
      .then((item) => normalizeOperatorAccesses([item])[0])
      .catch(async (error) => {
        await log('warn', 'No se pudo consultar AuxKey1 del acceso para OpenAI Vision', {
          accessId,
          error: error.message,
          status: error.status
        });
        return null;
      });
    if (access) {
      rememberOperatorAccessVisionKeys(session, [access]);
      const fetchedAccessKey = firstText(access.accessOpenaiApiKey);
      if (fetchedAccessKey) {
        return {
          apiKey: fetchedAccessKey,
          source: 'access',
          label: 'Acceso',
          accessId,
          accessKeySet: true,
          localKeySet: Boolean(config.openaiVision.apiKey)
        };
      }
    }
  }
  return {
    apiKey: config.openaiVision.apiKey,
    source: config.openaiVision.apiKey ? 'local' : 'missing',
    label: config.openaiVision.apiKey ? 'Local' : 'Sin key',
    accessId,
    accessKeySet: false,
    localKeySet: Boolean(config.openaiVision.apiKey)
  };
}

function resolveEoloUserSyncToken(options = {}) {
  const allowSavedConfigFallback = options.allowSavedConfigFallback !== false;
  if (options.token) {
    return {
      token: options.token,
      source: 'request-operator-session',
      userId: options.userId || ''
    };
  }
  const session = activeOperatorCloudSession();
  if (session?.token) {
    return {
      token: session.token,
      source: 'active-operator-session',
      userId: session.userId
    };
  }
  if (allowSavedConfigFallback && config.eolo.token) {
    return {
      token: config.eolo.token,
      source: 'saved-config-token',
      userId: ''
    };
  }
  return {
    token: '',
    source: allowSavedConfigFallback ? 'missing' : 'missing-active-operator-session',
    userId: ''
  };
}

function eoloUserSyncStatus() {
  const tokenContext = resolveEoloUserSyncToken();
  const scheduledTokenContext = resolveEoloUserSyncToken({ allowSavedConfigFallback: false });
  return {
    ...eoloUserSync.status(),
    effectiveTokenSet: Boolean(tokenContext.token),
    tokenSource: tokenContext.source,
    operatorUserId: tokenContext.userId || '',
    scheduledTokenSet: Boolean(scheduledTokenContext.token),
    scheduledTokenSource: scheduledTokenContext.source,
    scheduledOperatorUserId: scheduledTokenContext.userId || ''
  };
}

async function getOperatorSession(req) {
  const token = getOperatorToken(req);
  if (!token) return null;
  if (config.operator.authMode !== 'cloud') return operatorSessions.get(token) || null;

  const userId = String(req.headers['x-eolo-user-id'] || '').trim();
  const expiresAt = String(req.headers['x-eolo-expires-at'] || '').trim();
  if (!userId) return null;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return null;

  const cacheKey = `${token}:${userId}`;
  const cached = operatorCloudSessionCache.get(cacheKey);
  if (cached && cached.validUntil > Date.now()) {
    rememberOperatorCloudSession(cached.session);
    return cached.session;
  }

  const user = await fetchBubbleUser({ token, userId });
  const session = {
    token,
    userId,
    expiresAt: expiresAt || null,
    operator: operatorFromBubbleUser(user, { phone: user['phone number'] })
  };
  rememberOperatorCloudSession(session);
  const sessionExpiresAt = expiresAt ? Date.parse(expiresAt) : 0;
  const maxValidUntil = Number.isFinite(sessionExpiresAt) && sessionExpiresAt > Date.now()
    ? sessionExpiresAt
    : Date.now() + 120000;
  operatorCloudSessionCache.set(cacheKey, {
    session,
    validUntil: Math.min(Date.now() + 120000, maxValidUntil)
  });
  return session;
}

async function requireOperatorSession(req, _res, next) {
  try {
    const session = await getOperatorSession(req);
    if (!session) {
      const error = new Error('Sesion de operador requerida.');
      error.status = 401;
      next(error);
      return;
    }
    req.operatorSession = session;
    next();
  } catch (error) {
    error.status = error.status || 401;
    next(error);
  }
}

function operatorVersionSegment() {
  const version = String(config.operator.appVersion || 'live').replace(/^version-/, '');
  return version === 'live' ? '' : `version-${version}`;
}

function operatorWorkflowUrl(endpoint) {
  const versionSegment = operatorVersionSegment();
  const versionPath = versionSegment ? `/${versionSegment}` : '';
  return `${config.operator.appBaseUrl}${versionPath}/api/1.1/wf/${endpoint.replace(/^\/+/, '')}`;
}

function operatorWorkflowBaseUrl() {
  const versionSegment = operatorVersionSegment();
  const versionPath = versionSegment ? `/${versionSegment}` : '';
  return `${config.operator.appBaseUrl}${versionPath}/api/1.1/wf`;
}

async function publicOperatorCloudConfig() {
  const effectiveDeviceId = await operatorBridgeDeviceId();
  return {
    appBaseUrl: config.operator.appBaseUrl,
    appVersion: config.operator.appVersion,
    workflowBaseUrl: operatorWorkflowBaseUrl(),
    deviceHeartbeatEnabled: config.operator.deviceHeartbeatEnabled,
    deviceHeartbeatEndpoint: config.operator.deviceHeartbeatEndpoint,
    deviceHeartbeatWorkflowUrl: operatorWorkflowUrl(config.operator.deviceHeartbeatEndpoint),
    deviceDataType: config.operator.deviceDataType,
    deviceId: config.operator.deviceId,
    effectiveDeviceId,
    serialNumber: operatorBridgeSerial(),
    branchLabel:
      config.operator.appVersion === 'live'
        ? 'Produccion'
        : config.operator.appVersion === 'test'
          ? 'version-test'
        : config.operator.appVersion === '13i8l'
          ? 'bridge-dev'
        : config.operator.appVersion === '73hi5'
          ? 'acc-upd'
          : config.operator.appVersion
  };
}

function operatorFileUploadUrl(endpoint = config.operator.fileUploadEndpoint) {
  const versionSegment = operatorVersionSegment();
  const versionPath = versionSegment ? `/${versionSegment}` : '';
  return `${config.operator.appBaseUrl}${versionPath}/${endpoint.replace(/^\/+/, '')}`;
}

function withQuery(url, params = {}) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function operatorDataUrl(pathname) {
  const versionSegment = operatorVersionSegment();
  const versionPath = versionSegment ? `/${versionSegment}` : '';
  return `${config.operator.appBaseUrl}${versionPath}/api/1.1/obj/${pathname.replace(/^\/+/, '')}`;
}

async function loginOperatorWithBubble({ mode, phone, pin, code }) {
  if (!phone) {
    const error = new Error('El telefono es obligatorio para iniciar sesion.');
    error.status = 400;
    throw error;
  }

  const endpoint =
    mode === 'sms' && config.operator.smsLoginEndpoint
      ? config.operator.smsLoginEndpoint
      : config.operator.loginEndpoint;
  const payload = mode === 'sms' ? { phone, code } : { phone, pin };
  const response = await fetch(operatorWorkflowUrl(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status !== 'success') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo iniciar sesion en EOLO.'));
    error.status = response.status || 401;
    error.body = body;
    throw error;
  }

  const cloudSession = body.response || {};
  const token = cloudSession.token;
  const userId = cloudSession.user_id || cloudSession.userId || cloudSession.User;
  if (!token || !userId) {
    const error = new Error('EOLO no devolvio token o usuario de sesion.');
    error.status = 502;
    error.body = body;
    throw error;
  }

  const expiresSeconds = Number(cloudSession.expires || 0);
  const expiresAt = expiresSeconds
    ? new Date(Date.now() + expiresSeconds * 1000).toISOString()
    : null;
  const user = await fetchBubbleUser({ token, userId });
  return {
    token,
    userId,
    expiresAt,
    operator: operatorFromBubbleUser(user, { phone })
  };
}

async function fetchBubbleUser({ token, userId }) {
  const response = await fetch(operatorDataUrl(`user/${encodeURIComponent(userId)}`), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    const error = new Error(bubbleErrorMessage(body, 'Sesion EOLO no valida o expirada.'));
    error.status = response.status || 401;
    error.body = body;
    throw error;
  }
  return body.response || {};
}

async function fetchOperatorCloudAccesses(session) {
  const method = String(config.operator.accessesMethod || 'GET').toUpperCase();
  const response = await fetch(operatorWorkflowUrl(config.operator.accessesEndpoint), {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ user_id: session.userId }) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudieron consultar accesos autorizados.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return normalizeOperatorAccesses(body);
}

async function fetchOperatorCloudControlPoints(session, accessId) {
  const method = String(config.operator.controlPointsMethod || 'GET').toUpperCase();
  const baseUrl = operatorWorkflowUrl(config.operator.controlPointsEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, { access_id: accessId }) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ access_id: accessId }) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(
      bubbleErrorMessage(body, 'No se pudieron consultar puntos de control autorizados.')
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return normalizeOperatorControlPoints(body, accessId);
}

async function fetchOperatorCloudMovementsToday(session, accessId, controlPointId = '', options = {}) {
  const method = String(config.operator.movementsMethod || 'GET').toUpperCase();
  const baseUrl = operatorWorkflowUrl(config.operator.movementsEndpoint);
  const params = {
    access_id: accessId,
    ...(controlPointId ? { control_point_id: controlPointId } : {}),
    ...(options.dateFrom ? { date_from: normalizeBubbleDateParam(options.dateFrom, 'start') } : {}),
    ...(options.dateTo ? { date_to: normalizeBubbleDateParam(options.dateTo, 'end') } : {}),
    ...(options.limit !== undefined && options.limit !== '' ? { limit: options.limit } : {}),
    ...(options.offset !== undefined && options.offset !== '' ? { offset: options.offset } : {}),
    ...(options.sort ? { sort: options.sort } : {})
  };
  const url = method === 'GET' ? withQuery(baseUrl, params) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(params) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(
      bubbleErrorMessage(body, 'No se pudieron consultar movimientos de hoy.')
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return {
    movements: normalizeOperatorMovements(body, accessId),
    total: Number(body?.response?.total ?? body?.total ?? body?.response?.count_total ?? body?.count_total),
    count: Number(body?.response?.count ?? body?.count),
    raw: body
  };
}

async function fetchOperatorCloudResidents(session, accessId, search = '') {
  const method = String(config.operator.residentsMethod || 'GET').toUpperCase();
  const baseUrl = operatorWorkflowUrl(config.operator.residentsEndpoint);
  const params = {
    access_id: accessId,
    ...(search ? { search } : {})
  };
  const url = method === 'GET' ? withQuery(baseUrl, params) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(params) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudieron consultar residentes.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return normalizeOperatorResidents(body, accessId);
}

async function fetchOperatorDataList(session, type, constraints = [], options = {}) {
  const limit = Math.min(Number(options.limit) || 100, 100);
  let cursor = Number(options.cursor) || 0;
  const maxPages = Math.max(1, Number(options.maxPages) || 10);
  const items = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = withQuery(operatorDataUrl(type), {
      constraints: JSON.stringify(constraints),
      cursor,
      limit,
      ...(options.sortField ? { sort_field: options.sortField } : {}),
      ...(options.descending !== undefined ? { descending: Boolean(options.descending) } : {})
    });
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(options.timeoutMs || 12000)
    });
    const body = await response.json().catch(async () => ({ raw: await response.text() }));
    if (!response.ok || body.status === 'error') {
      const error = new Error(bubbleErrorMessage(body, `No se pudo consultar ${type}.`));
      error.status = response.status;
      error.body = body;
      throw error;
    }
    const responseBody = body?.response || body || {};
    const results = Array.isArray(responseBody.results) ? responseBody.results : [];
    items.push(...results);
    const remaining = Number(responseBody.remaining || 0);
    const count = Number(responseBody.count || results.length);
    if (!remaining || !count) break;
    cursor += count;
  }
  return items;
}

async function fetchOperatorDataPage(session, type, constraints = [], options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 1, 1), 100);
  const cursor = Number(options.cursor) || 0;
  const url = withQuery(operatorDataUrl(type), {
    constraints: JSON.stringify(constraints),
    cursor,
    limit,
    ...(options.sortField ? { sort_field: options.sortField } : {}),
    ...(options.descending !== undefined ? { descending: Boolean(options.descending) } : {})
  });
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(options.timeoutMs || 12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, `No se pudo consultar ${type}.`));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body?.response || body || {};
}

async function fetchOperatorDataCount(session, type, constraints = [], options = {}) {
  const responseBody = await fetchOperatorDataPage(session, type, constraints, {
    ...options,
    limit: 1,
    cursor: 0
  });
  const count = Number(responseBody.count || 0);
  const remaining = Number(responseBody.remaining || 0);
  const results = Array.isArray(responseBody.results) ? responseBody.results : [];
  return count + remaining || results.length;
}

async function fetchOperatorCloudAccessPermissions(session, accessId, options = {}) {
  const validAfterDate = parseOperatorDateValue(options.validAfter) || new Date();
  const validAfter = validAfterDate.toISOString();
  const constraints = [
    { key: 'acceso_custom_accesos', constraint_type: 'equals', value: accessId },
    { key: OPERATOR_ACCESS_PERMISSION_VALID_UNTIL_FIELD, constraint_type: 'greater than', value: validAfter }
  ];
  const items = await fetchOperatorDataList(session, OPERATOR_ACCESS_PERMISSION_DATA_TYPE, constraints, {
    limit: 100,
    maxPages: 5,
    sortField: 'Modified Date',
    descending: true,
    timeoutMs: 12000
  });
  const needle = normalizeSearchText(options.search || '');
  const permissions = items
    .map((item) => normalizeOperatorAccessPermission(item, accessId))
    .filter((permission) => isOperatorAccessPermissionDownloadable(permission, validAfterDate))
    .filter((permission) => {
      if (!needle) return true;
      return normalizeSearchText([
        permission.local_id,
        permission.principal_name,
        permission.user_name,
        permission.permission_type,
        permission.prefix,
        permission.user_id,
        permission.card_number,
        permission.qr_code,
        permission.plate
      ].join(' ')).includes(needle);
    });
  return {
    permissions,
    validAfter,
    sourceCount: items.length,
    skippedExpired: items.length - permissions.length
  };
}

async function fetchOperatorCloudAccessDevices(session, accessId) {
  const constraints = [
    { key: 'acceso_custom_accesos', constraint_type: 'equals', value: accessId }
  ];
  const items = await fetchOperatorDataList(session, OPERATOR_ACCESS_DEVICE_DATA_TYPE, constraints, {
    limit: 100,
    maxPages: 5,
    sortField: 'Modified Date',
    descending: true,
    timeoutMs: 12000
  });
  return items
    .map((item) => normalizeOperatorAccessDevice(item, accessId))
    .filter((device) => device.deviceId || device.id);
}

async function upsertOperatorCloudAccessDevice(session, payload = {}) {
  const accessId = firstText(payload.accessId, payload.access_id);
  const seed = firstText(
    payload.localDeviceId,
    payload.deviceId,
    payload.bridgeIdentifier,
    payload.name,
    payload.host,
    crypto.randomUUID()
  );
  const deviceId = normalizeBridgeDeviceId(seed);
  const sn = firstText(payload.bridgeIdentifier, payload.name, payload.host, deviceId);
  if (!deviceId) {
    const error = new Error('No se pudo generar un identificador para DispositivosAcceso.');
    error.status = 400;
    throw error;
  }

  const method = String(config.operator.deviceHeartbeatMethod || 'POST').toUpperCase();
  const bodyPayload = {
    device_id: deviceId,
    sn,
    ...(accessId ? { access_id: accessId } : {}),
    ...(payload.controlPointId ? { control_point_id: payload.controlPointId } : {}),
    ...(payload.controlPointName ? { control_point_name: payload.controlPointName } : {}),
    ...(payload.type ? { face_device_type: payload.type } : {}),
    ...(payload.host ? { host: payload.host } : {}),
    ...(payload.port ? { port: payload.port } : {}),
    ...(payload.protocol ? { protocol: payload.protocol } : {})
  };
  const baseUrl = operatorWorkflowUrl(config.operator.deviceHeartbeatEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error' || body.ok === false) {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo crear DispositivosAcceso.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }

  const workflow = body.response || body || {};
  const normalized = normalizeOperatorAccessDevice(workflow.device || workflow, accessId);
  const device = {
    ...normalized,
    deviceId: normalized.deviceId || deviceId,
    name: normalized.name || sn || deviceId,
    label: normalized.label || (sn && sn !== deviceId ? `${sn} · ${deviceId}` : sn || deviceId),
    accessId: normalized.accessId || accessId,
    type: normalized.type || firstText(payload.type),
    host: normalized.host || firstText(payload.host),
    controlPointId: normalized.controlPointId || firstText(payload.controlPointId),
    controlPointName: firstText(payload.controlPointName)
  };
  await log('info', 'DispositivosAcceso creado o actualizado desde Peatones', {
    accessId,
    deviceId,
    cloudId: device.id || '',
    controlPointId: payload.controlPointId || ''
  });
  return { ok: true, device, workflow };
}

async function ensureOperatorCloudAccessPermissionsId2(session, permissions = [], accessId = '') {
  const ensured = [];
  let assignedCount = 0;
  for (const permission of permissions) {
    if (!isCurrentOperatorPermissionId2(permission.id2_text || permission.id2) && assignedCount > 0) {
      await delay(1100);
    }
    const hadCurrentId2 = isCurrentOperatorPermissionId2(permission.id2_text || permission.id2);
    const ensuredPermission = await ensureOperatorCloudAccessPermissionId2(session, permission, accessId);
    if (!hadCurrentId2 && isCurrentOperatorPermissionId2(ensuredPermission.id2_text || ensuredPermission.id2)) {
      assignedCount += 1;
    }
    ensured.push(ensuredPermission);
  }
  return ensured;
}

async function ensureOperatorCloudAccessPermissionId2(session, permission = {}, accessId = '') {
  if (isCurrentOperatorPermissionId2(permission.id2_text || permission.id2)) return permission;
  if (!permission.id) return permission;
  try {
    const result = await assignOperatorCloudAccessPermissionId2(session, {
      accessId: permission.access_id || accessId,
      permissionId: permission.id,
      tipoPermiso: permission.permission_type,
      tipoEntidad: permission.entity_type
    });
    const id2 = normalizeOperatorPermissionId2(result.id2);
    if (!id2) return permission;
    return normalizeOperatorAccessPermission(
      {
        ...(permission.raw || permission),
        _id: permission.id,
        prefijopermisos_text: id2,
        id2_text: id2,
        ID2: id2
      },
      permission.access_id || accessId
    );
  } catch (error) {
    await log('warn', 'No se pudo asignar ID2 a PermisoAccesos desde EOLO Cloud', {
      permissionId: permission.id,
      accessId: permission.access_id || accessId,
      endpoint: OPERATOR_PERMISSION_ID2_ENDPOINT,
      error: error.message,
      status: error.status
    });
    return permission;
  }
}

async function assignOperatorCloudAccessPermissionId2(
  session,
  { accessId = '', permissionId = '', tipoPermiso = '', tipoEntidad = '' } = {}
) {
  const method = String(config.operator.permissionId2Method || 'POST').toUpperCase();
  const bodyPayload = {
    acceso: accessId,
    access_id: accessId,
    ...(permissionId ? { permiso: permissionId, permission_id: permissionId } : {}),
    tipo_permiso: bubbleAccessPermissionTypeOption(tipoPermiso),
    tipo_entidad: bubbleAccessPermissionEntityOption(tipoEntidad)
  };
  const baseUrl = operatorWorkflowUrl(OPERATOR_PERMISSION_ID2_ENDPOINT);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error' || body.ok === false) {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo generar ID2 para PermisoAccesos.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const workflow = body.response || body || {};
  const id2 = normalizeOperatorPermissionId2(firstText(
    workflow.id2,
    workflow.id2_text,
    workflow.ID2,
    workflow.permission?.prefijopermisos_text,
    workflow.permiso?.prefijopermisos_text,
    workflow.permission?.id2_text,
    workflow.permiso?.id2_text,
    workflow.permission?.ID2,
    workflow.permiso?.ID2
  ));
  if (!id2) {
    const error = new Error('EOLO Cloud no devolvio el ID2 generado para PermisoAccesos.');
    error.status = 502;
    error.body = body;
    throw error;
  }
  return {
    ok: true,
    id2,
    permissionId,
    accessId,
    workflow
  };
}

function bubbleAccessPermissionEntityOption(value = '') {
  const normalized = normalizeSearchText(value);
  if (normalized.includes('vehiculo') || normalized.includes('vehicle') || normalized.includes('auto')) {
    return 'Vehiculo';
  }
  if (normalized.includes('persona') || normalized.includes('peaton') || normalized.includes('pedestrian') || normalized.includes('person')) {
    return 'Persona';
  }
  return firstText(value);
}

function bubbleAccessPermissionTypeOption(value = '') {
  const normalized = normalizeSearchText(value);
  if (normalized.includes('residente') || normalized.includes('resident')) return 'Residente';
  if (normalized.includes('visitante') || normalized.includes('visitor') || normalized.includes('visita')) return 'Visitante';
  return firstText(value);
}

function inferOperatorAccessPermissionType(source = {}, rawId2 = '') {
  const resident = firstThingId(getField(
    source,
    'accesoresidente_custom_accesoresidentes',
    'AccesoResidente',
    'residente_custom_accesoresidentes',
    'Residente'
  ));
  if (resident) return 'Residente';
  const legacy = normalizeOperatorPermissionId2(rawId2);
  if (/(?:VR|PR)\d{14}$/.test(legacy)) return 'Residente';
  if (/(?:VV|PV)\d{14}$/.test(legacy)) return 'Visitante';
  if (/^R\d+/.test(legacy)) return 'Residente';
  if (/^V\d+/.test(legacy)) return 'Visitante';
  return '';
}

function normalizeOperatorAccessDevice(item = {}, fallbackAccessId = '') {
  const source = item && typeof item === 'object' ? item : {};
  const id = firstThingId(source);
  const access = getField(source, 'acceso_custom_accesos', 'Acceso', 'access_id', 'id_acceso');
  const deviceId = firstText(
    getField(
      source,
      'id_text',
      'ID',
      'Id',
      'dispositivo_id_text',
      'device_id',
      'deviceId',
      'id_dispositivo',
      'id_dispositivo_text',
      'localDeviceId',
      'Identificador'
    )
  ) || id;
  const name = firstText(
    getField(
      source,
      'sn_text',
      'SN',
      'nombre_text',
      'nombrelocal_text',
      'nombre_local_text',
      'Nombre',
      'Nombre Local',
      'name',
      'display',
      'bridgeidentifier_text',
      'identificador_text'
    )
  ) || deviceId || id || 'Dispositivo EOLO';
  const host = firstText(
    getField(source, 'ip_text', 'ip', 'host_text', 'host', 'url_text', 'direccion_text', 'address')
  );
  const type = firstText(
    getField(
      source,
      'tipo_text',
      'Tipo',
      'tipo_dispositivo_text',
      'tipo_option_tipo_dispositivo',
      'tipo_dispositivo_option_tipo_dispositivo'
    )
  );
  const controlPoint = getField(
    source,
    'punto_control_custom_accesoconfiguracion',
    'puntocontrol_custom_accesoconfiguracion',
    'accesoconfiguracion_custom_accesoconfiguracion',
    'PuntoControl',
    'Punto de Control'
  );
  return {
    id,
    deviceId,
    name,
    label: deviceId && deviceId !== name ? `${name} · ${deviceId}` : name,
    accessId: firstThingId(access) || fallbackAccessId,
    type,
    host,
    controlPointId: firstThingId(controlPoint),
    active: firstBooleanOrDefault(
      getField(source, 'activo_boolean', 'activo', 'Activo', 'active', 'enabled'),
      true
    ),
    lastCommunicationAt: firstText(
      getField(source, 'ultimacomunicacion_date', 'UltimaComunicacion', 'ultima_comunicacion_date')
    ),
    raw: source
  };
}

function isBubbleDataTypeNotFoundError(error) {
  const text = `${error?.message || ''} ${JSON.stringify(error?.body || {})}`.toLowerCase();
  return Number(error?.status) === 404 && text.includes('type not found');
}

function operatorAccessPermissionDate(source = {}, item = {}, keys = []) {
  return bubbleDateToIso(
    getField(source, ...keys) ||
    getField(item, ...keys) ||
    getField(item.raw || {}, ...keys)
  );
}

function isOperatorAccessPermissionDownloadable(permission = {}, now = new Date()) {
  const validUntil = bubbleDateToIso(
    permission.valid_until ||
    permission.validity_end ||
    permission.VigenciaFinal ||
    permission.vigenciafinal_date ||
    getField(permission.raw || {}, 'vigenciafinal_date', 'vigencia_final_date', 'VigenciaFinal', 'Vigencia Final')
  );
  const validUntilDate = parseOperatorDateValue(validUntil);
  if (!validUntilDate) return false;
  return validUntilDate.getTime() > now.getTime();
}

function filterDownloadableOperatorAccessPermissions(permissions = [], now = new Date()) {
  const filtered = [];
  let skippedExpired = 0;
  for (const permission of permissions) {
    if (isOperatorAccessPermissionDownloadable(permission, now)) {
      filtered.push(permission);
    } else {
      skippedExpired += 1;
    }
  }
  return {
    permissions: filtered,
    skippedExpired,
    validAfter: now.toISOString()
  };
}

function normalizeOperatorAccessPermission(item = {}, fallbackAccessId = '') {
  const source = operatorAccessPermissionSource(item);
  const accessId = firstThingId(getField(source, 'acceso_custom_accesos', 'Acceso')) || fallbackAccessId;
  const residentId = firstThingId(
    getField(
      source,
      'accesoresidente_custom_accesoresidentes',
      'acceso_residente_custom_accesoresidentes',
      'AccesoResidente',
      'Acceso Residente',
      'residente_custom_accesoresidentes',
      'Residente'
    )
  );
  const entityType = firstText(
    getField(
      source,
      'tipoentidad_option_tipo_entidad',
      'tipoentidad_option_tipo_transporte',
      'tipo_option_tipo_transporte',
      'tipoentidad_text',
      'TipoEntidad',
      'Tipo Entidad',
      'Tipo'
    )
  );
  const rawPermissionId2 = firstText(
    getField(
      source,
      'prefijopermisos_text',
      'id2_text',
      'ID2',
      'Id2',
      'id2',
      'ID 2',
      'permiso_id2_text',
      'PermisoID2'
    )
  );
  const explicitPermissionType = firstText(
    getField(
      source,
      'tipopermisoacceso_text',
      'tipopermiso_text',
      'permission_type',
      'tipopermiso_option_tipopermisoacceso',
      'tipopermisoacceso_option_tipo_permiso_acceso',
      'tipo_permiso_acceso',
      'TipoPermisoAcceso',
      'Tipo Permiso Acceso',
      'TipoPermiso',
      'Tipo Permiso',
      'tipo_text'
    )
  );
  const permissionType = bubbleAccessPermissionTypeOption(
    explicitPermissionType ||
      inferOperatorAccessPermissionType(source, rawPermissionId2) ||
      'PermisoAcceso'
  );
  const permissionId2 = normalizeOperatorPermissionId2(rawPermissionId2);
  const principalName = firstText(
    getField(
      source,
      'nombreprincipal_text',
      'NombrePrincipal',
      'Nombre Principal',
      'nombreusuario_text',
      'NombreUsuario',
      'nombre_usuario',
      'Nombre'
    )
  );
  const plate = normalizeOperatorPlate(firstText(
    getField(
      source,
      'placavehiculo_text',
      'placa_vehiculo_text',
      'placa_text',
      'placas_text',
      'PlacaVehiculo',
      'Placa Vehiculo',
      'Placa',
      'Placas',
      'placavehiculo',
      'placa',
      'placas'
    )
  ));
  const qrCode = firstText(
    getField(source, 'codigoqr_text', 'codigo_qr_text', 'CodigoQR', 'Codigo QR', 'codigoqr', 'qr_text')
  );
  const cardNumber = firstText(
    getField(source, 'numerotarjeta_text', 'numero_tarjeta_text', 'NumeroTarjeta', 'Numero Tarjeta', 'tarjeta_text')
  );
  const faceImage = firstFileUrl(
    getField(
      source,
      'imangenrostro_image',
      'imagenrostro_image',
      'imagen_rostro_image',
      'ImagenRostro',
      'ImangenRostro',
      'Imagen Rostro',
      'Imagen',
      'imagen_image',
      'face_image',
      'faceImage'
    ),
    item.face_image
  );
  const validFrom = operatorAccessPermissionDate(source, item, [
    'vigenciainicial_date',
    'vigencia_inicial_date',
    'VigenciaInicial',
    'Vigencia Inicial'
  ]);
  const validUntil = operatorAccessPermissionDate(source, item, [
    'vigenciafinal_date',
    'vigencia_final_date',
    'VigenciaFinal',
    'Vigencia Final'
  ]);
  const currentlyValid = isOperatorAccessPermissionDownloadable({ valid_until: validUntil }, new Date());
  const active = currentlyValid && !firstBoolean(
    getField(source, 'deleted', 'deleted_boolean', 'Eliminado', 'eliminado_boolean')
  ) && firstBooleanOrDefault(
    getField(source, 'activo_boolean', 'activo', 'Activo', 'active_boolean', 'Aprobado'),
    true
  );
  const automaticOpening = firstBoolean(
    getField(
      source,
      'aperturaautomatica_boolean',
      'apertura_automatica_boolean',
      'AperturaAutomatica',
      'Apertura Automatica',
      'aperturaautomatica'
    )
  );
  const entityTypeKey = normalizeSearchText(entityType || permissionType);
  const explicitVehicle = entityTypeKey.includes('vehiculo') ||
    entityTypeKey.includes('vehicle') ||
    entityTypeKey.includes('auto');
  const explicitPedestrian = entityTypeKey.includes('persona') ||
    entityTypeKey.includes('peaton') ||
    entityTypeKey.includes('pedestrian') ||
    entityTypeKey.includes('person');
  const isVehicle = explicitVehicle || (!explicitPedestrian && Boolean(plate));
  const isPedestrian = explicitPedestrian || !isVehicle;
  return {
    id: firstThingId(item.id, item._id, source._id, source.id),
    id2: permissionId2,
    id2_text: permissionId2,
    device_user_id: permissionId2,
    id2_current_format: isCurrentOperatorPermissionId2(permissionId2),
    access_id: accessId,
    local_id: firstText(getField(source, 'idlocal_text', 'IDLocal', 'IdLocal', 'id_local')),
    principal_name: principalName,
    user_name: principalName,
    entity_type: entityType || (isVehicle ? 'Vehiculo' : 'Persona'),
    permission_type: permissionType,
    prefix: permissionId2,
    resident_id: residentId,
    user_id: firstThingId(getField(source, 'usuario_user', 'Usuario', 'user')),
    valid_from: validFrom,
    valid_until: validUntil,
    validity_active: currentlyValid,
    plate,
    qr_code: qrCode,
    card_number: cardNumber,
    face_image: faceImage,
    automatic_opening: automaticOpening,
    active,
    is_pedestrian: isPedestrian,
    is_vehicle: isVehicle,
    has_plate: Boolean(plate),
    has_qr: Boolean(qrCode),
    has_card: Boolean(cardNumber),
    has_face: Boolean(faceImage),
    has_automatic_opening: automaticOpening,
    created_at: bubbleDateToIso(getField(item, 'Created Date')),
    modified_at: bubbleDateToIso(getField(item, 'Modified Date')),
    raw: item
  };
}

function operatorAccessPermissionSource(item = {}) {
  if (item && typeof item._source === 'object') {
    return {
      ...item._source,
      _id: item._id || item._source._id
    };
  }
  if (item && typeof item.raw === 'object') {
    return {
      ...item.raw,
      _id: item.id || item._id || item.raw._id
    };
  }
  if (item && typeof item.response === 'object') {
    return item.response;
  }
  return item || {};
}

function operatorAccessPermissionSchema() {
  return {
    type: OPERATOR_ACCESS_PERMISSION_DATA_TYPE,
    buildprintType: OPERATOR_ACCESS_PERMISSION_BUILDPRINT_TYPE,
    display: 'PermisoAccesos',
    confirmedByBuildprint: {
      acceso_custom_accesos: 'Acceso',
      idlocal_text: 'PermisoID',
      imangenrostro_image: 'ImangenRostro',
      nombreusuario_text: 'NombreUsuario',
      placavehiculo_text: 'PlacaVehiculo',
      prefijopermisos_text: 'ID2',
      tipo_option_tipo_transporte: 'TipoEntidad',
      tipopermiso_option_tipopermisoacceso: 'TipoPermisoAcceso',
      tipopermiso_text: 'TipoPermiso',
      usuario_user: 'Usuario',
      vigenciainicial_date: 'VigenciaInicial',
      vigenciafinal_date: 'VigenciaFinal'
    },
    localAliases: {
      ID2: ['prefijopermisos_text', 'id2_text', 'ID2', 'id2', 'permiso_id2_text'],
      NombrePrincipal: ['nombreprincipal_text', 'NombrePrincipal', 'nombreusuario_text'],
      TipoEntidad: ['tipoentidad_option_tipo_entidad', 'tipo_option_tipo_transporte', 'TipoEntidad', 'Tipo'],
      TipoPermisoAcceso: [
        'tipopermisoacceso_text',
        'tipopermiso_text',
        'tipopermiso_option_tipopermisoacceso',
        'TipoPermisoAcceso',
        'TipoPermiso',
        'Tipo Permiso'
      ],
      PlacaVehiculo: ['placavehiculo_text', 'PlacaVehiculo', 'placa_text', 'Placa'],
      NumeroTarjeta: ['numerotarjeta_text', 'NumeroTarjeta'],
      CodigoQR: ['codigoqr_text', 'CodigoQR'],
      AperturaAutomatica: ['aperturaautomatica_boolean', 'AperturaAutomatica'],
      VigenciaInicial: ['vigenciainicial_date', 'VigenciaInicial', 'Vigencia Inicial'],
      VigenciaFinal: ['vigenciafinal_date', 'VigenciaFinal', 'Vigencia Final']
    }
  };
}

function summarizeOperatorAccessPermissions(permissions = []) {
  const activePedestrians = permissions.filter((permission) => permission.active && permission.is_pedestrian);
  const activeVehicles = permissions.filter((permission) => permission.active && permission.is_vehicle);
  return {
    total: permissions.length,
    pedestrians: activePedestrians.length,
    faces: activePedestrians.filter((permission) => permission.has_face).length,
    cards: activePedestrians.filter((permission) => permission.has_card).length,
    codes: activePedestrians.filter((permission) => permission.has_qr).length,
    vehicles: activeVehicles.length,
    vehicle_plates: activeVehicles.filter((permission) => permission.has_plate).length,
    vehicle_cards: activeVehicles.filter((permission) => permission.has_card).length,
    vehicle_codes: activeVehicles.filter((permission) => permission.has_qr).length
  };
}

function operatorAccessPermissionsToDeviceEmployees(permissions = []) {
  return permissions
    .filter((permission) => permission.active !== false && permission.is_pedestrian && !permission.is_vehicle)
    .map((permission) => {
      const employeeNo = normalizeOperatorPermissionId2(permission.id2_text || permission.id2);
      if (!isCurrentOperatorPermissionId2(employeeNo)) return null;
      return {
        employeeNo,
        name: permission.principal_name || permission.user_name || `Permiso ${employeeNo}`,
        doorNo: (config.faceDevice === 'dahua' ? config.dahua : config.hikvision).doorNo,
        planTemplateNo: config.hikvision.planTemplateNo,
        faceUrl: permission.face_image || '',
        cardNo: permission.card_number || permission.qr_code || employeeNo,
        qrCode: permission.qr_code || '',
        sourcePermissionId: permission.id,
        sourcePermissionId2: employeeNo,
        sourceEntityType: permission.entity_type || permission.permission_type || ''
      };
    })
    .filter(Boolean);
}

function operatorAccessPermissionsSnapshotPath() {
  return path.join(config.dataDir, 'operator-access-permissions.json');
}

async function writeOperatorAccessPermissionsSnapshot(accessId, permissions = [], options = {}) {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const now = parseOperatorDateValue(options.validAfter) || new Date();
  const downloadable = filterDownloadableOperatorAccessPermissions(permissions, now);
  const currentPermissions = downloadable.permissions;
  const payload = {
    ok: true,
    access: accessId,
    downloadedAt: new Date().toISOString(),
    validAfter: options.validAfter || downloadable.validAfter,
    sourceCount: Number.isFinite(Number(options.sourceCount)) ? Number(options.sourceCount) : permissions.length,
    skippedExpired: (Number(options.skippedExpired) || 0) + downloadable.skippedExpired,
    total: currentPermissions.length,
    summary: summarizeOperatorAccessPermissions(currentPermissions),
    permissions: currentPermissions
  };
  await fs.promises.writeFile(operatorAccessPermissionsSnapshotPath(), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function readOperatorAccessPermissionsSnapshot(accessId, search = '') {
  try {
    const payload = JSON.parse(fs.readFileSync(operatorAccessPermissionsSnapshotPath(), 'utf8'));
    if (accessId && payload.access && payload.access !== accessId) return null;
    const needle = normalizeSearchText(search);
    const permissions = Array.isArray(payload.permissions)
      ? payload.permissions.map((permission) => normalizeOperatorAccessPermission(permission, accessId))
      : [];
    const current = filterDownloadableOperatorAccessPermissions(permissions).permissions;
    const filtered = !needle ? current : current.filter((permission) => normalizeSearchText([
      permission.local_id,
      permission.principal_name,
      permission.permission_type,
      permission.prefix,
      permission.plate,
      permission.card_number,
      permission.qr_code
    ].join(' ')).includes(needle));
    return {
      ...payload,
      permissionsTotalBeforeValidityFilter: permissions.length,
      permissions: filtered
    };
  } catch (_error) {
    return null;
  }
}

async function handleFacialAccessEvent(record = {}) {
  if (record.operationalDuplicate) return;
  if (!isMovementCandidateFacialEvent(record)) {
    await log('debug', 'Evento facial ignorado para movimiento por no ser acceso reconocido', {
      faceDeviceId: record.faceDeviceId,
      eventType: record.eventType,
      eventState: record.eventState,
      employeeNo: record.employeeNo,
      cardNo: record.cardNo
    });
    return;
  }

  const accessId = firstText(config.eolo.access, record.access_id, record.accessId);
  const permission = findFacialPermissionForEvent(record, accessId);
  if (!permission) {
    await log('info', 'Evento facial sin PermisoAccesos local; no se crea movimiento', {
      faceDeviceId: record.faceDeviceId,
      employeeNo: record.employeeNo,
      cardNo: record.cardNo,
      accessId
    });
    return;
  }
  if (!permission.active || !permission.is_pedestrian || permission.is_vehicle) {
    await log('info', 'Evento facial no corresponde a permiso peatonal activo; no se crea movimiento', {
      permissionId: permission.id,
      active: permission.active,
      entityType: permission.entity_type,
      accessId: permission.access_id || accessId
    });
    return;
  }

  const eventKey = facialMovementEventKey(record, permission);
  if (rememberFacialMovementEvent(eventKey)) {
    await log('debug', 'Movimiento facial duplicado ignorado', {
      eventKey,
      permissionId: permission.id,
      faceDeviceId: record.faceDeviceId
    });
    return;
  }

  const faceDevice = faceDeviceForEvent(record);
  const session = activeOperatorCloudSession();
  const context = await resolveFacialMovementContext({ record, permission, faceDevice, session });
  if (!context.accessId || !context.controlPointId) {
    await log('warn', 'No se pudo crear movimiento facial por falta de acceso o punto de control', {
      permissionId: permission.id,
      accessId: context.accessId,
      controlPointId: context.controlPointId,
      faceDeviceId: record.faceDeviceId,
      contextSource: context.source
    });
    return;
  }

  const movementPermission = await permissionWithResidentForFacialMovement(permission, context.accessId, session);
  if (!movementPermission.resident_id) {
    await log('warn', 'No se pudo crear movimiento facial por falta de AccesoResidente en PermisoAccesos', {
      permissionId: permission.id,
      permissionId2: permission.id2,
      userId: permission.user_id,
      accessId: context.accessId,
      faceDeviceId: record.faceDeviceId
    });
    return;
  }

  const movementPayload = await ensureOperatorMovementLocalId2(
    facialEventMovementPayload({ record, permission: movementPermission, faceDevice, context }),
    context.accessId
  );

  try {
    if (config.operator.authMode === 'cloud' && session?.token) {
      const createdMovement = await createOperatorCloudMovement(
        session,
        movementPayload,
        context.accessId,
        context.controlPointId
      );
      invalidateOperatorInventorySummary(context.accessId);
      await recordOperatorMovementEvent({ operatorSession: session }, {
        payload: movementPayload,
        movement: createdMovement,
        accessId: context.accessId,
        controlPointId: context.controlPointId,
        source: 'facial-stream-cloud'
      });
      await log('info', 'Movimiento peatonal creado desde evento facial', {
        movementId: createdMovement?.id || createdMovement?.uid_bubble || '',
        permissionId: permission.id,
        faceDeviceId: record.faceDeviceId,
        accessId: context.accessId,
        controlPointId: context.controlPointId
      });
      return;
    }

    const missingSessionError = new Error('No hay sesion EOLO activa para sincronizar movimiento facial.');
    missingSessionError.status = 401;
    const pending = await createPendingOperatorMovement(
      movementPayload,
      context.accessId,
      context.controlPointId,
      missingSessionError
    );
    await recordOperatorMovementEvent({ operatorSession: { operator: { name: 'Reconocimiento facial' } } }, {
      payload: movementPayload,
      movement: pending.movement,
      accessId: context.accessId,
      controlPointId: context.controlPointId,
      source: 'facial-stream-local-pending'
    });
    await log('warn', 'Movimiento facial guardado pendiente por falta de sesion EOLO activa', {
      localId: pending.id,
      permissionId: permission.id,
      faceDeviceId: record.faceDeviceId,
      accessId: context.accessId,
      controlPointId: context.controlPointId
    });
  } catch (error) {
    if (!isRetryableOperatorCloudError(error)) throw error;
    const pending = await createPendingOperatorMovement(
      movementPayload,
      context.accessId,
      context.controlPointId,
      error
    );
    await recordOperatorMovementEvent({ operatorSession: session || { operator: { name: 'Reconocimiento facial' } } }, {
      payload: movementPayload,
      movement: pending.movement,
      accessId: context.accessId,
      controlPointId: context.controlPointId,
      source: 'facial-stream-local-pending'
    });
    await log('warn', 'Movimiento facial guardado localmente por EOLO Cloud inaccesible', {
      localId: pending.id,
      permissionId: permission.id,
      faceDeviceId: record.faceDeviceId,
      accessId: context.accessId,
      controlPointId: context.controlPointId,
      error: error.message
    });
  }
}

function isMovementCandidateFacialEvent(record = {}) {
  const identifier = firstText(record.employeeNo, record.employeeNoString, record.cardNo);
  if (!identifier) return false;
  const mode = normalizeSearchText(record.currentVerifyMode);
  const typeText = normalizeSearchText([record.eventType, record.majorEventType].filter(Boolean).join(' '));
  const stateText = normalizeSearchText([record.eventState, record.subEventType].filter(Boolean).join(' '));
  if (/heartbeat|keepalive/.test(typeText)) return false;
  if (/denied|deny|failed|fail|invalid|forbid|reject|alarm/.test(stateText)) return false;
  if (!mode) return true;
  return /face|rostro|card|tarjeta|finger|huella|access|verify/.test(mode);
}

function findFacialPermissionForEvent(record = {}, accessId = '') {
  const snapshot = readOperatorAccessPermissionsSnapshot(accessId, '');
  const permissions = snapshot?.permissions || [];
  if (!permissions.length) return null;
  const identifiers = [
    firstText(record.employeeNo, record.employeeNoString),
    firstText(record.cardNo)
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!identifiers.length) return null;
  const normalizedIds = new Set(identifiers.map((value) => normalizeSearchText(value)));
  return permissions.find((permission) => {
    const candidates = [
      permission.id2,
      permission.id2_text,
      permission.device_user_id,
      permission.id,
      permission.local_id,
      permission.card_number,
      permission.qr_code
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return candidates.some((value) => normalizedIds.has(normalizeSearchText(value)));
  }) || null;
}

function faceDeviceForEvent(record = {}) {
  const id = String(record.faceDeviceId || '').trim();
  return config.faceDevices.find((item) => item.id === id) ||
    (record.faceDeviceType === config.faceDevice ? activeFaceDeviceSettings() : {}) ||
    {};
}

function facialMovementEventKey(record = {}, permission = {}) {
  return firstText(record.serialNo)
    ? `serial:${record.faceDeviceId || ''}:${record.serialNo}`
    : `permission:${record.faceDeviceId || ''}:${permission.id2 || permission.id || record.employeeNo || record.cardNo}`;
}

function rememberFacialMovementEvent(key = '') {
  if (!key) return false;
  if (facialMovementEventKeys.has(key)) return true;
  facialMovementEventKeys.add(key);
  if (facialMovementEventKeys.size > 2000) {
    const keep = [...facialMovementEventKeys].slice(-1000);
    facialMovementEventKeys.clear();
    keep.forEach((item) => facialMovementEventKeys.add(item));
  }
  return false;
}

async function resolveFacialMovementContext({ record = {}, permission = {}, faceDevice = {}, session = null } = {}) {
  const accessId = firstText(permission.access_id, config.eolo.access, record.access_id, record.accessId);
  const configuredControlPointId = firstText(
    faceDevice.controlPointId,
    faceDevice.control_point_id,
    faceDevice.id_punto_control,
    record.control_point_id,
    record.controlPointId
  );
  if (configuredControlPointId) {
    return {
      accessId,
      controlPointId: configuredControlPointId,
      controlPointName: firstText(faceDevice.controlPointName, record.control_point_name, record.doorNo),
      controlPointAction: firstText(faceDevice.controlPointAction),
      controlPointActionMode: firstText(faceDevice.controlPointActionMode),
      source: 'configured-device'
    };
  }
  if (!session?.token || !accessId) {
    return { accessId, controlPointId: '', source: 'missing-session-or-access' };
  }

  const cacheKey = `${session.userId || 'operator'}:${accessId}:${record.faceDeviceId || ''}`;
  const cached = facialMovementContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.context;

  const points = await fetchOperatorCloudControlPoints(session, accessId).catch(async (error) => {
    await log('warn', 'No se pudieron consultar puntos de control para movimiento facial', {
      accessId,
      faceDeviceId: record.faceDeviceId,
      error: error.message,
      status: error.status
    });
    return [];
  });
  const activePoints = points.filter((point) => point.active !== false);
  const matched = matchFacialControlPoint(activePoints, { record, faceDevice });
  const selected = matched || activePoints[0] || null;
  const source = matched
    ? 'matched-cloud-control-point'
    : activePoints.length === 1
      ? 'single-cloud-control-point'
      : selected
        ? 'first-cloud-control-point'
        : 'no-control-point';
  if (selected && source === 'first-cloud-control-point') {
    await log('warn', 'Movimiento facial usara el primer punto de control disponible', {
      accessId,
      selectedControlPointId: selected.id,
      selectedControlPointName: selected.name,
      faceDeviceId: record.faceDeviceId,
      availableControlPoints: activePoints.length
    });
  }
  const context = {
    accessId,
    controlPointId: selected?.id || '',
    controlPointName: selected?.name || firstText(record.doorNo),
    controlPointAction: selected?.actionType || '',
    controlPointActionMode: selected?.actionMode || '',
    source
  };
  facialMovementContextCache.set(cacheKey, {
    context,
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  return context;
}

function matchFacialControlPoint(points = [], { record = {}, faceDevice = {} } = {}) {
  const needles = [
    faceDevice.controlPointId,
    faceDevice.localDeviceId,
    faceDevice.id,
    faceDevice.host,
    faceDevice.name,
    faceDevice.bridgeIdentifier,
    record.deviceName,
    record.device,
    record.doorNo
  ]
    .map((value) => normalizeSearchText(value))
    .filter((value) => value && value.length > 1);
  if (!needles.length) return null;
  return points.find((point) => {
    const haystack = normalizeSearchText(JSON.stringify({
      id: point.id,
      name: point.name,
      type: point.type,
      entryCamera: point.entryCamera,
      exitCamera: point.exitCamera,
      cameras: point.cameras,
      cameraIds: point.cameraIds,
      raw: point.raw
    }));
    return needles.some((needle) => haystack.includes(needle));
  }) || null;
}

function facialEventMovementPayload({ record = {}, permission = {}, faceDevice = {}, context = {} } = {}) {
  const permissionId2 = normalizeOperatorPermissionId2(firstText(permission.id2_text, permission.id2, record.employeeNo));
  const residentId = operatorPermissionResidentId(permission);
  const personName = normalizeOperatorPersonName(firstText(
    permission.principal_name,
    permission.user_name,
    record.name,
    `Permiso ${permission.id || record.employeeNo || record.cardNo}`
  ));
  const faceImage = firstFileUrl(permission.face_image);
  const cardOrQr = firstText(permission.card_number, permission.qr_code, record.cardNo);
  const deviceName = firstText(faceDevice.name, faceDevice.bridgeIdentifier, record.deviceName, record.device);
  const verifyMode = firstText(record.currentVerifyMode, record.subEventType, record.eventType);
  const controlPointName = firstText(context.controlPointName, context.controlPointId, 'punto de control');
  const automaticNote = `Evento de peatón generado automáticamente por reconocimiento facial en ${controlPointName} (${permissionId2 || permission.id || record.employeeNo || 'sin ID2'})`;
  return {
    access_id: context.accessId,
    id_acceso: context.accessId,
    control_point_id: context.controlPointId,
    id_punto_control: context.controlPointId,
    punto_control_name: context.controlPointName,
    control_point_action: context.controlPointAction || 'Solo Registrar',
    control_point_action_mode: context.controlPointActionMode || 'register',
    kind: 'Peaton',
    tipo_transporte: 'Peaton',
    movement_type: firstText(permission.permission_type, 'PermisoAcceso'),
    razon_acceso: firstText(permission.permission_type, 'PermisoAcceso'),
    visitor_name: personName,
    nombre_visitante: personName,
    nombre_responsable: personName,
    resident_id: residentId,
    residente_id: residentId,
    usuario_id: permission.user_id || '',
    permission_user_id: permission.user_id || '',
    permiso_acceso_id: permission.id || '',
    permisoacceso_id: permission.id || '',
    source_permission_id: permission.id || '',
    permiso_acceso_id2: permissionId2,
    permission_id2: permissionId2,
    face_employee_no: firstText(record.employeeNo, permissionId2, permission.id),
    face_device_id: firstText(record.faceDeviceId, faceDevice.id),
    face_device_type: firstText(record.faceDeviceType, faceDevice.type),
    face_device_name: deviceName,
    face_event_serial: firstText(record.serialNo),
    face_event_type: firstText(record.eventType, record.majorEventType),
    face_verify_mode: verifyMode,
    card_number: cardOrQr,
    numero_tarjeta: firstText(permission.card_number, record.cardNo),
    qr_code: permission.qr_code || '',
    codigo_qr: permission.qr_code || '',
    id_photo_url: faceImage,
    identification_photo_url: faceImage,
    face_image_url: faceImage,
    imagen_rostro_url: faceImage,
    notes: automaticNote,
    nota: automaticNote,
    approved_by_device: true,
    aprobado_por_dispositivo: true,
    status: 'Ingresado',
    operator_name: 'Reconocimiento facial',
    source: 'facial-stream'
  };
}

async function permissionWithResidentForFacialMovement(permission = {}, accessId = '', session = null) {
  const existingResidentId = operatorPermissionResidentId(permission);
  if (existingResidentId) return { ...permission, resident_id: existingResidentId };
  const userId = firstThingId(permission.user_id, permission.permission_user_id);
  if (!session?.token || !userId || !accessId) return permission;
  const residentId = await findOperatorAccessResidentIdByUser(session, accessId, userId).catch(async (error) => {
    await log('warn', 'No se pudo resolver AccesoResidente para movimiento facial', {
      permissionId: permission.id,
      permissionId2: permission.id2,
      userId,
      accessId,
      error: error.message,
      status: error.status
    });
    return '';
  });
  return residentId ? { ...permission, resident_id: residentId } : permission;
}

function operatorPermissionResidentId(permission = {}) {
  return firstThingId(
    permission.resident_id,
    permission.residente_id,
    getField(
      permission.raw || {},
      'accesoresidente_custom_accesoresidentes',
      'acceso_residente_custom_accesoresidentes',
      'AccesoResidente',
      'Acceso Residente',
      'residente_custom_accesoresidentes',
      'Residente'
    )
  );
}

async function findOperatorAccessResidentIdByUser(session, accessId, userId) {
  const constraints = [
    { key: 'acceso_custom_accesos', constraint_type: 'equals', value: accessId },
    { key: 'usuario1_user', constraint_type: 'equals', value: userId },
    { key: 'deleted_boolean', constraint_type: 'not equal', value: true }
  ];
  const residents = await fetchOperatorDataList(session, 'accesoresidentes', constraints, {
    limit: 1,
    maxPages: 1,
    sortField: 'Created Date',
    descending: true,
    timeoutMs: 12000
  });
  return firstThingId(residents[0]);
}

async function mergeOperatorAccessPermissionSnapshot(accessId, permission) {
  const current = readOperatorAccessPermissionsSnapshot(accessId)?.permissions || [];
  const next = current.some((item) => item.id === permission.id)
    ? current.map((item) => (item.id === permission.id ? permission : item))
    : [permission, ...current];
  return writeOperatorAccessPermissionsSnapshot(accessId, next);
}

function normalizeOperatorAccessPermissionPatch(body = {}, accessId = '') {
  const payload = {
    acceso_custom_accesos: accessId
  };
  if (body.id2 !== undefined || body.id2_text !== undefined || body.ID2 !== undefined) {
    payload.prefijopermisos_text = normalizeOperatorPermissionId2(firstText(body.id2_text, body.id2, body.ID2));
  }
  if (body.local_id !== undefined || body.PermisoID !== undefined) {
    payload.idlocal_text = firstText(body.local_id, body.PermisoID);
  }
  if (body.principal_name !== undefined || body.NombrePrincipal !== undefined) {
    payload.nombreusuario_text = firstText(body.principal_name, body.NombrePrincipal);
  }
  if (payload.prefijopermisos_text === undefined && (body.prefix !== undefined || body.PermisoPrefijo !== undefined)) {
    payload.prefijopermisos_text = firstText(body.prefix, body.PermisoPrefijo);
  }
  if (body.face_image !== undefined || body.ImangenRostro !== undefined || body.ImagenRostro !== undefined) {
    payload.imangenrostro_image = firstText(body.face_image, body.ImangenRostro, body.ImagenRostro);
  }
  if (body.user_id !== undefined || body.Usuario !== undefined) {
    payload.usuario_user = firstThingId(body.user_id, body.Usuario);
  }
  return payload;
}

function localFallbackAccessPermissions(accessId, search = '') {
  const items = [
    normalizeOperatorAccessPermission({
      _id: 'local-permiso-demo',
      'Created Date': Date.now(),
      'Modified Date': Date.now(),
      acceso_custom_accesos: accessId,
      idlocal_text: '12345',
      nombreusuario_text: 'FAISAN',
      prefijopermisos_text: 'A',
      vigenciafinal_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      usuario_user: 'local-user-demo'
    }, accessId)
  ];
  const needle = normalizeSearchText(search);
  if (!needle) return items;
  return items.filter((item) => normalizeSearchText([
    item.local_id,
    item.user_name,
    item.prefix,
    item.user_id
  ].join(' ')).includes(needle));
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function readLocalEventHistory() {
  const filePath = path.join(config.dataDir, 'events.jsonl');
  const fromFile = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
    : [];
  const recentMemoryEvents = getEvents(500).reverse();
  const seen = new Set();
  return [...fromFile, ...recentMemoryEvents].filter((event) => {
    const key = [
      event.receivedAt,
      event.dateTime,
      event.serialNo,
      event.eventType,
      event.employeeNo,
      event.plate || event.placa
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseEventBoundary(value, edge = 'start') {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (edge === 'end') date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);
    return date;
  }
  return parseOperatorDateValue(raw);
}

function normalizeLocalEvent(event = {}) {
  const raw = event.raw || {};
  const access = raw.AccessControllerEvent || event.AccessControllerEvent || {};
  const timestamp = firstText(
    event.detected_at,
    event.detectedAt,
    event.dateTime,
    event.receivedAt,
    event.ts,
    raw.dateTime
  );
  const plate = firstText(
    event.plate,
    event.placa,
    event.license_plate,
    event.licensePlate,
    getField(event, 'plate_text', 'placas_text'),
    raw.plate,
    raw.placa,
    raw.licensePlate
  );
  const personName = firstText(
    event.name,
    event.person_name,
    event.personName,
    event.user_name,
    access.name,
    raw.name
  );
  const employeeNo = firstText(
    event.employeeNo,
    event.employee_no,
    event.employeeNoString,
    access.employeeNoString,
    access.employeeNo
  );
  const vehicleClass = firstText(
    event.vehicle_class,
    event.vehicleClass,
    raw.vehicle_class,
    raw.vehicleClass
  );
  const camera = firstText(
    event.camera,
    event.camera_name,
    event.cameraName,
    event.channelName,
    raw.camera,
    raw.channelName,
    access.deviceName
  );
  const device = firstText(
    event.device,
    event.deviceName,
    event.device_name,
    event.ipAddress,
    raw.deviceName,
    raw.ipAddress,
    access.deviceName
  );
  const type = firstText(
    event.type,
    event.eventType,
    event.event_type,
    raw.eventType,
    access.subEventType,
    access.majorEventType,
    'Evento'
  );
  const hasVehicle = Boolean(plate || vehicleClass || normalizeSearchText(type).includes('vehicle'));
  const hasPerson = Boolean(personName || employeeNo || normalizeSearchText(type).includes('face'));
  const objectType = hasVehicle && hasPerson
    ? 'Vehiculo y persona'
    : hasVehicle
      ? 'Vehiculo'
      : hasPerson
        ? 'Persona'
        : 'No identificado';
  const identifiedValue = hasVehicle
    ? firstText(plate, vehicleClass, 'Vehiculo detectado')
    : hasPerson
      ? firstText(personName, employeeNo, 'Persona identificada')
      : '';
  const detail = firstText(
    event.detail,
    event.message,
    event.eventDescription,
    raw.eventDescription,
    access.currentVerifyMode,
    event.eventState,
    raw.eventState,
    'Registro local'
  );
  return {
    id: crypto.createHash('sha1').update(JSON.stringify([
      event.receivedAt,
      timestamp,
      type,
      camera,
      device,
      identifiedValue,
      event.serialNo
    ])).digest('hex').slice(0, 16),
    timestamp,
    receivedAt: event.receivedAt || '',
    type,
    objectType,
    identifiedValue,
    camera,
    device,
    detail,
    hasVehicle,
    hasPerson,
    rawText: JSON.stringify(event)
  };
}

function summarizeLocalEvents(events = []) {
  const vehicleIdentified = events.filter((event) => event.hasVehicle).length;
  const personIdentified = events.filter((event) => event.hasPerson).length;
  return {
    total: events.length,
    identified: events.filter((event) => event.hasVehicle || event.hasPerson).length,
    vehicleIdentified,
    personIdentified
  };
}

async function recordOperatorMovementEvent(req, { payload = {}, movement = {}, accessId = '', controlPointId = '', source = '' } = {}) {
  try {
    const operator = req.operatorSession?.operator || {};
    const companions = normalizeOperatorCompanionPayload(payload.companions || payload.companions_json);
    const companionName = firstText(...companions.map((companion) => companion.name));
    const personName = normalizeOperatorPersonName(firstText(
      payload.visitor_name,
      payload.nombre_visitante,
      payload.nombre_responsable,
      movement.visitor_name,
      movement.driver,
      companionName
    ));
    const plate = normalizeOperatorPlate(firstText(
      payload.placa,
      payload.placas,
      movement.placa
    ));
    const accessName = firstText(
      payload.access_name,
      payload.acceso_name,
      movement.accessName,
      movement.access_name,
      accessId
    );
    const controlPointName = firstText(
      payload.control_point_name,
      payload.punto_control_name,
      movement.controlPointName,
      movement.control_point_name,
      controlPointId
    );
    const movementId = firstText(
      movement.id,
      movement.uid_bubble,
      movement.folio_display,
      payload.id2_text,
      payload.id2
    );
    await addEvent({
      type: 'Movimiento creado',
      eventType: 'operator_movement_created',
      eventState: 'active',
      dateTime: new Date().toISOString(),
      plate,
      placa: plate,
      person_name: personName,
      camera: controlPointName,
      device: accessName,
      detail: `Movimiento generado por ${firstText(operator.name, payload.operator_name, 'Operador EOLO')}`,
      movement_id: movementId,
      movement_type: firstText(payload.movement_type, movement.movement_type),
      movement_kind: firstText(payload.kind, movement.kind),
      source,
      operator_name: firstText(operator.name, payload.operator_name),
      operator_phone: firstText(operator.phone),
      operator_user_id: firstText(operator.userId, operator.user_id, operator.id),
      access_id: accessId || firstText(payload.access_id, payload.id_acceso, movement.accessId),
      access_name: accessName,
      control_point_id: controlPointId || firstText(payload.control_point_id, payload.id_punto_control, movement.controlPointId),
      control_point_name: controlPointName,
      raw: {
        movement,
        payload: {
          access_id: firstText(payload.access_id, payload.id_acceso),
          access_name: accessName,
          control_point_id: firstText(payload.control_point_id, payload.id_punto_control),
          control_point_name: controlPointName,
          placa: plate,
          visitor_name: personName,
          movement_type: firstText(payload.movement_type),
          kind: firstText(payload.kind)
        }
      }
    });
  } catch (error) {
    await log('warn', 'No se pudo registrar evento local de movimiento de operador', {
      error: error.message,
      accessId,
      controlPointId
    });
  }
}

function bubbleDateToIso(value) {
  const date = parseOperatorDateValue(value);
  return date ? date.toISOString() : '';
}

async function fetchOperatorDataItem(session, type, id) {
  const itemId = firstText(id);
  if (!itemId) return null;
  const response = await fetch(operatorDataUrl(`${type}/${encodeURIComponent(itemId)}`), {
    headers: { Authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, `No se pudo consultar ${type}.`));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body?.response || body || null;
}

async function createOperatorDataItem(session, type, payload = {}) {
  const response = await fetch(operatorDataUrl(type), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, `No se pudo crear ${type}.`));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body?.response || body || {};
}

async function patchOperatorDataItem(session, type, id, payload = {}) {
  const response = await fetch(operatorDataUrl(`${type}/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, `No se pudo actualizar ${type}.`));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body?.response || body || {};
}

async function fetchOperatorCloudInventorySummary(session, accessId) {
  const { start, end } = currentYearDateRange();
  const cacheKey = `${accessId}:${start.toISOString()}`;
  const cached = operatorInventorySummaryCache.get(cacheKey);
  if (cached && cached.validUntil > Date.now()) return cached.summary;

  const openMovementConstraints = [
    { key: 'acceso_custom_accesos', constraint_type: 'equals', value: accessId },
    { key: 'Created Date', constraint_type: 'greater than', value: start.toISOString() },
    { key: 'Created Date', constraint_type: 'less than', value: end.toISOString() },
    { key: 'horasalida_date', constraint_type: 'is_empty' }
  ];
  const startedAt = Date.now();
  try {
    const rawMovements = await fetchOperatorDataList(session, 'accesomovimiento', openMovementConstraints, {
      limit: 100,
      maxPages: 25,
      sortField: 'Created Date',
      descending: true,
      timeoutMs: 12000
    });
    const summary = summarizeOperatorMovements(
      normalizeOperatorMovements(rawMovements, accessId).filter((movement) => {
        const createdAt = parseOperatorDateValue(movement.created_at || movement.fecha_entrada || movement.modified_at);
        return movement.status === 'Ingresado' && (!createdAt || (createdAt >= start && createdAt < end));
      })
    );
    operatorInventorySummaryCache.set(cacheKey, {
      summary,
      validUntil: Date.now() + 60000
    });
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 1500) {
      await log('info', 'Inventario EOLO Cloud consultado con conteo ligero', {
        accessId,
        elapsedMs,
        vehicles: summary.vehicles,
        pedestrians: summary.pedestrians
      });
    }
    return summary;
  } catch (error) {
    await log('warn', 'No se pudo consultar inventario por movimientos abiertos; usando pagina reciente', {
      error: error.message,
      status: error.status,
      accessId
    });
  }

  const rawMovements = await fetchOperatorDataList(session, 'accesomovimiento', [
    { key: 'acceso_custom_accesos', constraint_type: 'equals', value: accessId },
    { key: 'Created Date', constraint_type: 'greater than', value: start.toISOString() },
    { key: 'Created Date', constraint_type: 'less than', value: end.toISOString() }
  ], {
    limit: 100,
    maxPages: 50,
    sortField: 'Created Date',
    descending: true,
    timeoutMs: 15000
  });
  const movements = normalizeOperatorMovements(rawMovements, accessId).filter((movement) => {
    const createdAt = parseOperatorDateValue(movement.created_at || movement.fecha_entrada || movement.modified_at);
    return movement.status === 'Ingresado' && (!createdAt || (createdAt >= start && createdAt < end));
  });
  const summary = summarizeOperatorMovements(movements);
  operatorInventorySummaryCache.set(cacheKey, {
    summary,
    validUntil: Date.now() + 30000
  });
  return summary;
}

function invalidateOperatorInventorySummary(accessId) {
  const id = firstText(accessId);
  if (!id) return;
  for (const key of operatorInventorySummaryCache.keys()) {
    if (key.startsWith(`${id}:`)) operatorInventorySummaryCache.delete(key);
  }
}

function currentYearDateRange(now = new Date()) {
  const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
  return { start, end };
}

async function fetchOperatorCloudPlateProfile(session, accessId, plate) {
  const normalizedPlate = normalizePlateForLookup(plate);
  if (!accessId || !normalizedPlate) return null;
  const workflowProfile = await fetchOperatorCloudPlateProfileWorkflow(session, accessId, normalizedPlate)
    .catch(async (error) => {
      await log('warn', 'No se pudo consultar perfil de placa residente en EOLO Cloud', {
        error: error.message,
        status: error.status,
        accessId,
        plate: normalizedPlate
      });
      return null;
    });
  const vehicleRecord = workflowProfile?.vehicle || await fetchOperatorCloudVehicleByPlate(session, normalizedPlate).catch(async (error) => {
    await log('warn', 'No se pudo consultar vehiculo por placa en EOLO Cloud', {
      error: error.message,
      status: error.status,
      plate: normalizedPlate
    });
    return null;
  });
  const vehicleDrivers = vehicleRecord
    ? await fetchOperatorCloudVehicleDrivers(session, vehicleRecord).catch(async (error) => {
      await log('warn', 'No se pudieron consultar conductores del vehiculo en EOLO Cloud', {
        error: error.message,
        status: error.status,
        vehicleId: vehicleRecord.id
      });
      return [];
    })
    : [];
  const constraints = [
    {
      key: 'acceso_custom_accesos',
      constraint_type: 'equals',
      value: accessId
    },
    {
      key: 'placas_text',
      constraint_type: 'text contains',
      value: normalizedPlate
    }
  ];
  const url = withQuery(operatorDataUrl('accesomovimiento'), {
    constraints: JSON.stringify(constraints),
    sort_field: 'Created Date',
    descending: true,
    limit: 10
  });
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo consultar historial de placa.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const movements = normalizeOperatorMovements(body, accessId)
    .filter((movement) => normalizePlateForLookup(movement.placa) === normalizedPlate)
    .filter((movement) => movement.visitor_name || movement.id_image || hasOperatorVehicleDetails(movement));
  const identityMovement =
    movements.find((item) => item.id_image && item.visitor_name) ||
    movements.find((item) => item.id_image) ||
    movements.find((item) => item.visitor_name) ||
    null;
  const vehicleMovement =
    movements.find((item) => hasOperatorVehicleDetails(item)) ||
    movements[0] ||
    null;
  const movement = identityMovement || vehicleMovement || null;
  const selectedDriver =
    vehicleDrivers.find((driver) => driver.id && driver.id === movement?.driver_id) ||
    vehicleDrivers.find((driver) => driver.id_image && driver.name) ||
    vehicleDrivers.find((driver) => driver.name) ||
    null;
  const residentProfile = workflowProfile?.resident || null;
  if (!movement && !vehicleRecord && !selectedDriver && !residentProfile) return null;
  const accessVehicle = workflowProfile?.access_vehicle || null;
  const residentRegistered = Boolean(residentProfile?.id && workflowProfile?.resident_registered);
  return {
    placa: movement?.placa || vehicleRecord?.placa || normalizedPlate,
    visitor_name: selectedDriver?.name || movement?.visitor_name || '',
    id_image: selectedDriver?.id_image || movement?.id_image || '',
    vehicle: {
      ...operatorVehicleProfile(vehicleMovement || movement || {}),
      ...(vehicleRecord || {})
    },
    vehicle_id: vehicleRecord?.id || firstThingId(movement?.raw?.vehiculo_custom_vehicle),
    driver_id: selectedDriver?.id || firstThingId(movement?.raw?.conductor_custom_conductor),
    drivers: vehicleDrivers,
    resident: residentProfile,
    resident_id: residentProfile?.id || '',
    resident_name: residentProfile?.name || '',
    resident_registered: residentRegistered,
    vehicle_registered: Boolean(vehicleRecord?.id),
    vehicle_registered_access: Boolean(accessVehicle?.id || residentRegistered),
    access_vehicle_id: accessVehicle?.id || '',
    movement_id: movement?.id || '',
    folio_display: movement?.folio_display || movement?.id || '',
    last_seen_at: movement?.fecha_entrada || movement?.created_at || movement?.modified_at || '',
    movement
  };
}

async function fetchOperatorCloudPlateProfileWorkflow(session, accessId, plate) {
  const method = String(config.operator.plateProfileMethod || 'GET').toUpperCase();
  const baseUrl = operatorWorkflowUrl(config.operator.plateProfileEndpoint);
  const params = {
    access_id: accessId,
    plate
  };
  const url = method === 'GET' ? withQuery(baseUrl, params) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(params) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo consultar perfil de placa.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return normalizeOperatorPlateProfile(body, accessId, plate);
}

function normalizeOperatorPlateProfile(body, fallbackAccessId = '', fallbackPlate = '') {
  const response = body?.response || body || {};
  const vehicle = normalizeOperatorVehicle(getField(response, 'vehicle', 'vehiculo', 'Vehicle'));
  const accessVehicle =
    normalizeOperatorVehicle(getField(response, 'access_vehicle', 'accessVehicle', 'vehiculo_acceso')) ||
    (operatorVehicleBelongsToAccess(vehicle, fallbackAccessId) ? vehicle : null);
  const directResident = normalizeOperatorResidentRecord(
    getField(
      response,
      'access_resident',
      'accessResident',
      'residente_acceso',
      'resident',
      'residente'
    ),
    fallbackAccessId
  );
  const ownerResident = normalizeOperatorResidentRecord(
    getField(response, 'owner_resident', 'ownerResident', 'residente_owner'),
    fallbackAccessId
  );
  const vehicleResidentSource =
    accessVehicle?.raw ||
    (operatorVehicleBelongsToAccess(vehicle, fallbackAccessId) ? vehicle?.raw : null);
  const vehicleResident = normalizeOperatorResidentRecord(
    getField(vehicleResidentSource, 'accesoresidente_custom_accesoresidentes', 'AccesoResidente'),
    fallbackAccessId
  );
  const resident = directResident || vehicleResident || ownerResident || null;
  const effectiveVehicle = accessVehicle || vehicle;
  if (!effectiveVehicle && !resident) return null;
  return {
    vehicle: effectiveVehicle
      ? {
        ...effectiveVehicle,
        placa: effectiveVehicle.placa || fallbackPlate
      }
      : null,
    access_vehicle: accessVehicle
      ? {
        ...accessVehicle,
        placa: accessVehicle.placa || fallbackPlate
      }
      : null,
    resident,
    resident_registered: Boolean(resident?.id),
    raw: response
  };
}

function operatorVehicleBelongsToAccess(vehicle, accessId) {
  if (!vehicle?.raw || !accessId) return false;
  return firstThingId(getField(vehicle.raw, 'access_id', 'acceso_custom_accesos', 'Acceso')) === accessId;
}

async function fetchOperatorCloudVehicleByPlate(session, plate) {
  const normalizedPlate = normalizePlateForLookup(plate);
  if (!normalizedPlate) return null;
  const vehicles = await fetchOperatorDataList(
    session,
    'vehicle',
    [{ key: 'placas_text', constraint_type: 'equals', value: normalizedPlate }],
    { limit: 10, maxPages: 1, sortField: 'Modified Date', descending: true }
  );
  const normalized = vehicles
    .map(normalizeOperatorVehicle)
    .find((vehicle) => normalizePlateForLookup(vehicle.placa) === normalizedPlate);
  return normalized || null;
}

async function fetchOperatorCloudVehicleDrivers(session, vehicle = {}) {
  const ids = normalizeThingIdList(vehicle.raw?.conductor_list_custom_conductor || vehicle.raw?.Conductores);
  const drivers = [];
  for (const id of ids) {
    const record = await fetchOperatorDataItem(session, 'conductor', id).catch(() => null);
    const driver = normalizeOperatorDriver(record);
    if (driver?.id) drivers.push(driver);
  }
  return drivers;
}

function hasOperatorVehicleDetails(movement) {
  return Boolean(
    movement?.economic_number ||
    movement?.vehicle_type ||
    movement?.vehicle_category ||
    movement?.vehicle_year ||
    movement?.color ||
    movement?.brand ||
    movement?.model ||
    movement?.vehicle_description
  );
}

function operatorVehicleProfile(movement) {
  const parsedDescription = parseOperatorVehicleDescription(movement?.vehicle_description || '');
  return {
    id: firstThingId(movement?.vehicle_id, movement?.raw?.vehiculo_custom_vehicle),
    economic_number: movement?.economic_number || '',
    vehicle_type: movement?.vehicle_type || parsedDescription.vehicle_type || '',
    vehicle_category: movement?.vehicle_category || parsedDescription.vehicle_category || '',
    vehicle_year: movement?.vehicle_year || '',
    color: movement?.color || '',
    brand: movement?.brand || '',
    model: movement?.model || '',
    vehicle_description: movement?.vehicle_description || ''
  };
}

function normalizeOperatorVehicle(item = {}) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: firstThingId(item),
    placa: firstText(getField(item, 'placa', 'placas', 'placas_text', 'Placas')),
    economic_number: firstText(getField(item, 'economic_number', 'numEconomico', 'numeconomico_text')),
    vehicle_type: firstText(getField(item, 'vehicle_type', 'tipo_option_tipo_vehiculo_os', 'tipo')),
    vehicle_category: firstText(getField(item, 'vehicle_category', 'categoria_option_capacidad_inspeccion_os')),
    vehicle_year: firstText(getField(item, 'vehicle_year', 'yearModel', 'yearmodel_number')),
    color: firstText(getField(item, 'color', 'color_text')),
    brand: firstText(getField(item, 'brand', 'make', 'make_text')),
    model: firstText(getField(item, 'model', 'model_text')),
    image: firstFileUrl(getField(item, 'image', 'image_file')),
    raw: item
  };
}

function normalizeOperatorDriver(item = {}) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: firstThingId(item),
    name: firstText(getField(item, 'name', 'nombre', 'nombre_text', 'Nombre')),
    phone: firstText(getField(item, 'phone', 'telefono', 'telefono_text', 'Telefono')),
    license: firstText(getField(item, 'license', 'num_licencia_text', 'Num_Licencia')),
    id_image: firstFileUrl(getField(item, 'id_image', 'id_frontal_file', 'Licencia_Frontal')),
    raw: item
  };
}

function normalizeOperatorResidentRecord(item = {}, fallbackAccessId = '') {
  if (!item || typeof item !== 'object') return null;
  const id = firstThingId(item);
  const name = firstText(
    getField(
      item,
      'name',
      'nombre',
      'nombre_text',
      'Nombre',
      'fullname_text',
      'nombre_completo_text',
      'residente_text'
    )
  );
  if (!id && !name) return null;
  const access = getField(item, 'access_id', 'id_acceso', 'Acceso', 'acceso_custom_accesos');
  return {
    id,
    name,
    area: firstText(getField(item, 'area', 'Area', 'Área', 'area_text', 'departamento_text', 'Departamento')),
    phone: firstText(getField(item, 'phone', 'telefono', 'Telefono', 'Teléfono', 'telefono_text')),
    company: firstText(getField(item, 'empresa', 'Empresa', 'empresa_text', 'Empresa Text')),
    isArea: firstBoolean(getField(item, 'isArea', 'is_area', 'EsArea', 'esarea_boolean')),
    accessId: typeof access === 'object' ? firstThingId(access) || fallbackAccessId : firstText(access) || fallbackAccessId,
    raw: item
  };
}

function normalizeThingIdList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => firstThingId(item)).filter(Boolean);
  if (typeof value === 'object') return [firstThingId(value)].filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      return normalizeThingIdList(JSON.parse(text));
    } catch (_error) {
      // Si no es JSON valido, continua con el parser tolerante por comas.
    }
  }
  return text
    .split(',')
    .map((item) => firstThingId(item))
    .filter(Boolean);
}

function parseOperatorVehicleDescription(value) {
  const text = firstText(value).replace(/\s+/g, ' ').trim();
  if (!text) return {};
  const parts = text.split(' ').filter(Boolean);
  return {
    vehicle_type: parts[0] || '',
    vehicle_category: parts[1] || ''
  };
}

async function createOperatorCloudMovement(session, payload, accessId, controlPointId) {
  const method = String(config.operator.createMovementMethod || 'POST').toUpperCase();
  const baseUrl = operatorWorkflowUrl(config.operator.createMovementEndpoint);
  const payloadWithLocalId2 = await ensureOperatorMovementLocalId2(payload, accessId);
  const bodyPayload = buildOperatorMovementPayload(payloadWithLocalId2, accessId, controlPointId);
  await ensureOperatorMovementResidentId(session, bodyPayload, accessId);
  const companions = normalizeOperatorCompanionPayload(payloadWithLocalId2.companions || bodyPayload.companions_json);
  const idPhotoDataUrl = bodyPayload.id_photo_data_url;
  let idPhotoUrl = firstFileUrl(bodyPayload.id_photo_url);
  const vehiclePhotoDataUrl = bodyPayload.vehicle_photo_data_url;
  delete bodyPayload.companions_json;
  delete bodyPayload.id_photo_data_url;
  delete bodyPayload.identification_photo_data_url;
  delete bodyPayload.id_photo_url;
  delete bodyPayload.vehicle_photo_data_url;
  delete bodyPayload.entry_photo_data_url;
  delete bodyPayload.vehicle_photo_url;
  delete bodyPayload.entry_image_url;
  delete bodyPayload.image;
  delete bodyPayload.imagen;
  let vehicleFileUrl = '';
  if (vehiclePhotoDataUrl) {
    vehicleFileUrl = await uploadOperatorBubbleFile(session, vehiclePhotoDataUrl, {
      filename: `vehiculo-${bodyPayload.placa || 'sin-placa'}-${Date.now()}.jpg`
    });
    Object.assign(bodyPayload, {
      vehicle_photo_url: vehicleFileUrl,
      entry_image_url: vehicleFileUrl,
      entry_image: vehicleFileUrl,
      imagen_entrada_file: vehicleFileUrl,
      image: vehicleFileUrl,
      imagen: vehicleFileUrl
    });
  }
  if (idPhotoDataUrl && !idPhotoUrl) {
    idPhotoUrl = await uploadOperatorBubbleFile(session, idPhotoDataUrl, {
      filename: `identificacion-${bodyPayload.placa || 'sin-placa'}-${Date.now()}.jpg`
    });
  }
  if (idPhotoUrl) {
    Object.assign(bodyPayload, {
      id_photo_url: idPhotoUrl,
      id_front_file: idPhotoUrl,
      id_frontal_file: idPhotoUrl,
      identification_file: idPhotoUrl
    });
  }
  const workflowHandlesVehicleDriver =
    bodyPayload.kind === 'Vehiculo' &&
    Boolean(bodyPayload.vehicle_id || bodyPayload.driver_id || bodyPayload.id_photo_url);
  const existingMovement = await fetchOperatorCloudMovementById2(
    session,
    accessId,
    bodyPayload.id2_text
  );
  if (existingMovement?.id) {
    const movementWithExistingPhoto = idPhotoUrl && !existingMovement.id_image
      ? { ...existingMovement, id_image: idPhotoUrl }
      : existingMovement;
    const enrichedExisting = await enrichOperatorCloudMovement(
      session,
      movementWithExistingPhoto,
      bodyPayload,
      accessId,
      {
        idPhotoUrl,
        companions,
        skipVehicleDriverSync: workflowHandlesVehicleDriver
      }
    ).catch(async (error) => {
      await log('warn', 'Movimiento EOLO existente por folio no pudo enriquecerse completamente', {
        movementId: existingMovement.id,
        id2: bodyPayload.id2_text,
        error: error.message,
        status: error.status
      });
      return movementWithExistingPhoto;
    });
    return applyOperatorId2ToMovement(enrichedExisting || movementWithExistingPhoto, bodyPayload);
  }
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo crear el movimiento en EOLO.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  let createdMovement = applyOperatorId2ToMovement(normalizeOperatorMovement(body, accessId), bodyPayload);
  if (!createdMovement?.id && bodyPayload.id2_text) {
    const recoveredMovement = await fetchOperatorCloudMovementById2(session, accessId, bodyPayload.id2_text);
    createdMovement = applyOperatorId2ToMovement(recoveredMovement, bodyPayload) || createdMovement;
  }
  if (!createdMovement?.id) {
    const error = new Error('EOLO no devolvio un AccesoMovimiento creado ni se pudo recuperar por folio local.');
    error.status = 502;
    error.body = body;
    throw error;
  }
  const movementWithVehiclePhoto = vehicleFileUrl && createdMovement
    ? { ...createdMovement, entry_image: createdMovement.entry_image || vehicleFileUrl }
    : createdMovement;
  if (!idPhotoDataUrl && !idPhotoUrl) {
    const enrichedMovement = await enrichOperatorCloudMovement(session, movementWithVehiclePhoto, bodyPayload, accessId, {
      companions,
      skipVehicleDriverSync: workflowHandlesVehicleDriver
    });
    return applyOperatorId2ToMovement(enrichedMovement || movementWithVehiclePhoto, bodyPayload);
  }
  const fileUrl = idPhotoUrl;
  const attachedMovement = await attachOperatorIdentificationPhoto(
    session,
    movementWithVehiclePhoto,
    accessId,
    fileUrl
  );
  const movementWithIdPhoto = attachedMovement
    ? { ...attachedMovement, entry_image: attachedMovement.entry_image || vehicleFileUrl }
    : { ...movementWithVehiclePhoto, id_image: fileUrl };
  const enrichedMovement = await enrichOperatorCloudMovement(session, movementWithIdPhoto, bodyPayload, accessId, {
    idPhotoUrl: fileUrl,
    companions,
    skipVehicleDriverSync: workflowHandlesVehicleDriver
  });
  return applyOperatorId2ToMovement(enrichedMovement || movementWithIdPhoto, bodyPayload);
}

async function ensureOperatorMovementResidentId(session, payload = {}, accessId = '') {
  if (payload.resident_id || !session?.token || !accessId) return payload;
  const userId = firstThingId(payload.permission_user_id, payload.usuario_id);
  if (!userId) return payload;
  const residentId = await findOperatorAccessResidentIdByUser(session, accessId, userId).catch(async (error) => {
    await log('warn', 'No se pudo resolver AccesoResidente para payload de movimiento EOLO', {
      accessId,
      userId,
      id2: payload.id2_text,
      source: payload.source,
      error: error.message,
      status: error.status
    });
    return '';
  });
  if (residentId) {
    payload.resident_id = residentId;
    payload.residente_id = residentId;
  }
  return payload;
}

async function fetchOperatorCloudMovementById2(session, accessId, id2) {
  const normalizedId2 = normalizeOperatorMovementId2(id2);
  if (!session?.token || !accessId || !normalizedId2) return null;
  const constraints = [
    { key: 'acceso_custom_accesos', constraint_type: 'equals', value: accessId },
    { key: 'id2_text', constraint_type: 'equals', value: normalizedId2 }
  ];
  const rawMovements = await fetchOperatorDataList(session, 'accesomovimiento', constraints, {
    limit: 1,
    maxPages: 1,
    sortField: 'Created Date',
    descending: true,
    timeoutMs: 12000
  }).catch(async (error) => {
    await log('warn', 'EOLO creo movimiento pero no se pudo recuperar por folio', {
      accessId,
      id2: normalizedId2,
      error: error.message,
      status: error.status
    });
    return [];
  });
  const movement = normalizeOperatorMovements(rawMovements, accessId)[0] || null;
  if (movement?.id) {
    await log('info', 'Movimiento EOLO recuperado por folio local', {
      accessId,
      id2: normalizedId2,
      movementId: movement.id
    });
  }
  return movement;
}

function applyOperatorId2ToMovement(movement, payload = {}) {
  const id2 = normalizeOperatorMovementId2(firstText(payload.id2_text, payload.id2, payload.folio_display));
  if (!movement || !id2) return movement;
  return {
    ...movement,
    id2,
    id2_text: id2,
    folio_display: id2,
    raw: {
      ...(movement.raw || {}),
      id2_text: id2
    }
  };
}

async function uploadOperatorBubbleFile(session, dataUrl, { attachTo = '', filename = '' } = {}) {
  const file = parseDataUrl(dataUrl);
  if (!file) {
    const error = new Error('La fotografia de identificacion no tiene un formato valido.');
    error.status = 400;
    throw error;
  }
  const extension = file.mimeType === 'image/png' ? 'png' : 'jpg';
  const bodyPayload = {
    name: filename || `identificacion-${Date.now()}.${extension}`,
    contents: file.base64,
    private: Boolean(attachTo),
    ...(attachTo ? { attach_to: attachTo } : {})
  };
  const response = await fetch(operatorFileUploadUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/plain',
      Authorization: `Bearer ${session.token}`
    },
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(20000)
  });
  const text = (await response.text()).trim();
  const fileUrl = bubbleUploadFileUrl(text);
  if (!response.ok || !fileUrl) {
    const error = new Error(text || 'No se pudo subir la fotografia a EOLO.');
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return fileUrl;
}

async function attachOperatorIdentificationPhoto(session, movement, accessId, fileUrl) {
  const method = String(config.operator.attachIdentificationMethod || 'POST').toUpperCase();
  const bodyPayload = {
    movement_id: movement.id,
    access_id: accessId,
    id_front_file: fileUrl,
    id_frontal_file: fileUrl,
    identification_file: fileUrl
  };
  const baseUrl = operatorWorkflowUrl(config.operator.attachIdentificationEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error') {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo adjuntar la identificacion al movimiento.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return normalizeOperatorMovement(body, accessId) || { ...movement, id_image: fileUrl };
}

async function enrichOperatorCloudMovement(
  session,
  movement,
  payload,
  accessId,
  { idPhotoUrl = '', companions = [], skipVehicleDriverSync = false } = {}
) {
  if (!movement?.id) return movement;
  const patches = {};
  let vehicle = null;
  let driver = null;
  if (!skipVehicleDriverSync && payload.kind === 'Vehiculo' && payload.placa) {
    vehicle = await ensureOperatorCloudVehicle(session, payload).catch(async (error) => {
      await log('warn', 'No se pudo asegurar vehiculo EOLO para el movimiento', {
        error: error.message,
        status: error.status,
        movementId: movement.id,
        plate: payload.placa
      });
      return null;
    });
    driver = await ensureOperatorCloudDriver(session, payload, { idPhotoUrl }).catch(async (error) => {
      await log('warn', 'No se pudo asegurar conductor EOLO para el movimiento', {
        error: error.message,
        status: error.status,
        movementId: movement.id,
        plate: payload.placa
      });
      return null;
    });
    if (vehicle?.id) patches.vehiculo_custom_vehicle = vehicle.id;
    if (driver?.id) patches.conductor_custom_conductor = driver.id;
    if (vehicle?.id && driver?.id) {
      await attachOperatorDriverToVehicle(session, vehicle, driver.id, payload.vehicle_driver_ids).catch(async (error) => {
        await log('warn', 'No se pudo ligar conductor al vehiculo EOLO', {
          error: error.message,
          status: error.status,
          vehicleId: vehicle.id,
          driverId: driver.id
        });
      });
    }
  }

  const companionIds = await createOperatorCloudCompanions(session, movement, payload, accessId, companions)
    .catch(async (error) => {
      await log('warn', 'No se pudieron crear acompañantes EOLO para el movimiento', {
        error: error.message,
        status: error.status,
        movementId: movement.id
      });
      return [];
    });
  if (companionIds.length) patches.lista_acompa_antes_list_custom_accesomovimiento = companionIds;
  const automaticPatch = isAutomaticFacialMovementPayload(payload)
    ? automaticFacialMovementPatchPayload(payload)
    : {};

  if (automaticPatch.Estatus) {
    await tryOperatorDataPayloads(
      (candidate) => patchOperatorDataItem(session, 'accesomovimiento', movement.id, candidate),
      [
        { Estatus: automaticPatch.Estatus }
      ]
    ).catch(async (error) => {
      await log('warn', 'No se pudo marcar movimiento facial como Ingresado en EOLO', {
        error: error.message,
        status: error.status,
        movementId: movement.id,
        attemptedValues: [automaticPatch.Estatus]
      });
    });
  }

  if (automaticPatch.Referencia) {
    await tryOperatorDataPayloads(
      (candidate) => patchOperatorDataItem(session, 'accesomovimiento', movement.id, candidate),
      [
        { Referencia: automaticPatch.Referencia }
      ]
    ).catch(async (error) => {
      await log('warn', 'No se pudo guardar nota de movimiento facial en EOLO', {
        error: error.message,
        status: error.status,
        movementId: movement.id
      });
    });
  }

  if (Object.keys(patches).length) {
    const movementPatchCandidates = [
      patches,
      {
        ...(patches.vehiculo_custom_vehicle ? { Vehiculo: patches.vehiculo_custom_vehicle } : {}),
        ...(patches.conductor_custom_conductor ? { Conductor: patches.conductor_custom_conductor } : {}),
        ...(patches.lista_acompa_antes_list_custom_accesomovimiento
          ? { Acompanantes: patches.lista_acompa_antes_list_custom_accesomovimiento }
          : {})
      }
    ];
    await tryOperatorDataPayloads(
      (candidate) => patchOperatorDataItem(session, 'accesomovimiento', movement.id, candidate),
      movementPatchCandidates
    ).catch(async (error) => {
      await log('warn', 'No se pudieron guardar asociaciones adicionales del movimiento EOLO', {
        error: error.message,
        status: error.status,
        movementId: movement.id,
        fields: Object.keys(patches)
      });
    });
  }
  const forcedIncoming = isAutomaticFacialMovementPayload(payload);
  return {
    ...movement,
    vehicle_id: vehicle?.id || movement.vehicle_id || '',
    driver_id: driver?.id || movement.driver_id || '',
    driver: driver?.name || movement.driver || '',
    companions: companionIds.length ? companionIds : movement.companions || [],
    ...(forcedIncoming ? { status: 'Ingresado', can_exit: true } : {})
  };
}

function isAutomaticFacialMovementPayload(payload = {}) {
  return payload.source === 'facial-stream' || payload.approved_by_device === true || payload.aprobado_por_dispositivo === true;
}

function automaticFacialMovementPatchPayload(payload = {}) {
  const note = firstText(payload.notes, payload.nota);
  return {
    Estatus: 'Ingresado',
    ...(note ? { Referencia: note } : {})
  };
}

async function ensureOperatorCloudVehicle(session, payload = {}) {
  const plate = normalizePlateForLookup(payload.placa);
  const selectedId = firstText(payload.vehicle_id);
  if (selectedId) {
    const record = await fetchOperatorDataItem(session, 'vehicle', selectedId).catch(() => null);
    const normalized = normalizeOperatorVehicle(record);
    return normalized || { id: selectedId, placa: plate, raw: {} };
  }
  if (!plate) return null;
  const existing = await fetchOperatorCloudVehicleByPlate(session, plate);
  if (existing?.id) {
    const patches = operatorVehiclePatchPayloads(payload, plate);
    if (patches.some((patch) => Object.keys(patch).length > 1)) {
      await tryOperatorDataPayloads((patch) => patchOperatorDataItem(session, 'vehicle', existing.id, patch), patches);
    }
    return existing;
  }
  const created = await tryOperatorDataPayloads(
    (candidate) => createOperatorDataItem(session, 'vehicle', candidate),
    operatorVehiclePatchPayloads(payload, plate)
  );
  return { id: firstThingId(created), placa: plate, raw: created };
}

async function ensureOperatorCloudDriver(session, payload = {}, { idPhotoUrl = '' } = {}) {
  const selectedId = firstText(payload.driver_id);
  if (selectedId) {
    const record = await fetchOperatorDataItem(session, 'conductor', selectedId).catch(() => null);
    const normalized = normalizeOperatorDriver(record) || { id: selectedId, name: payload.visitor_name || '' };
    if (idPhotoUrl) {
      await tryOperatorDataPayloads(
        (candidate) => patchOperatorDataItem(session, 'conductor', selectedId, candidate),
        operatorDriverPhotoPayloads(idPhotoUrl)
      ).catch((error) => {
        log('warn', 'No se pudo actualizar foto del conductor existente', { driverId: selectedId, error: error.message });
      });
      normalized.id_image = idPhotoUrl;
    }
    return normalized;
  }
  const name = normalizeOperatorPersonName(payload.visitor_name);
  if (!name) return null;
  const phone = firstText(payload.telefono);
  const constraints = [
    { key: 'nombre_text', constraint_type: 'equals', value: name },
    ...(phone ? [{ key: 'telefono_text', constraint_type: 'equals', value: phone }] : [])
  ];
  const existing = (await fetchOperatorDataList(session, 'conductor', constraints, { limit: 5, maxPages: 1 })
    .catch(async () => fetchOperatorDataList(session, 'conductor', [
      { key: 'Nombre', constraint_type: 'equals', value: name },
      ...(phone ? [{ key: 'Telefono', constraint_type: 'equals', value: phone }] : [])
    ], { limit: 5, maxPages: 1 }).catch(() => [])))
    .map(normalizeOperatorDriver)
    .find((driver) => driver?.id);
  if (existing?.id) {
    if (idPhotoUrl) {
      await tryOperatorDataPayloads(
        (candidate) => patchOperatorDataItem(session, 'conductor', existing.id, candidate),
        operatorDriverPhotoPayloads(idPhotoUrl)
      ).catch((error) => {
        log('warn', 'No se pudo actualizar foto del conductor recuperado', { driverId: existing.id, error: error.message });
      });
      existing.id_image = idPhotoUrl;
    }
    return existing;
  }
  const created = await tryOperatorDataPayloads(
    (candidate) => createOperatorDataItem(session, 'conductor', candidate),
    operatorDriverCreatePayloads(name, phone, idPhotoUrl)
  );
  return {
    id: firstThingId(created),
    name,
    phone,
    id_image: idPhotoUrl,
    raw: created
  };
}

async function attachOperatorDriverToVehicle(session, vehicle, driverId, knownDriverIds = []) {
  const currentIds = normalizeThingIdList(vehicle.raw?.conductor_list_custom_conductor || vehicle.raw?.Conductores);
  const knownIds = normalizeThingIdList(knownDriverIds);
  const nextIds = [...new Set([...currentIds, ...knownIds, driverId].filter(Boolean))];
  await tryOperatorDataPayloads(
    (candidate) => patchOperatorDataItem(session, 'vehicle', vehicle.id, candidate),
    [
      { conductor_list_custom_conductor: nextIds },
      { Conductores: nextIds }
    ]
  );
}

function operatorVehiclePatchPayloads(payload = {}, plate = '') {
  const year = Number(payload.vehicle_year) || undefined;
  const internal = {
    placas_text: plate,
    ...(payload.economic_number ? { numeconomico_text: payload.economic_number } : {}),
    ...(payload.color ? { color_text: payload.color } : {}),
    ...(payload.brand ? { make_text: payload.brand } : {}),
    ...(payload.model ? { model_text: payload.model } : {}),
    ...(year ? { yearmodel_number: year } : {})
  };
  const display = {
    placas: plate,
    ...(payload.color ? { color: payload.color } : {}),
    ...(year ? { yearModel: year } : {})
  };
  return [internal, display].map((item) => {
    Object.keys(item).forEach((key) => item[key] === undefined && delete item[key]);
    return item;
  });
}

function operatorDriverCreatePayloads(name, phone = '', idPhotoUrl = '') {
  return [
    {
      nombre_text: name,
      ...(phone ? { telefono_text: phone } : {}),
      ...(idPhotoUrl ? { id_frontal_file: idPhotoUrl } : {})
    },
    {
      Nombre: name,
      ...(phone ? { Telefono: phone } : {}),
      ...(idPhotoUrl ? { Licencia_Frontal: idPhotoUrl } : {})
    }
  ];
}

function operatorDriverPhotoPayloads(idPhotoUrl = '') {
  return [
    { id_frontal_file: idPhotoUrl },
    { Licencia_Frontal: idPhotoUrl }
  ];
}

async function tryOperatorDataPayloads(operation, payloads = []) {
  let lastError = null;
  for (const payload of payloads) {
    const cleanPayload = Object.fromEntries(
      Object.entries(payload || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
    if (!Object.keys(cleanPayload).length) continue;
    try {
      return await operation(cleanPayload);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      if (!/unrecognized field|unknown field|invalid key|no such field/i.test(message) && error?.status !== 400) break;
    }
  }
  if (lastError) throw lastError;
  return {};
}

async function createOperatorCloudCompanions(session, movement, payload, accessId, companions = []) {
  const createdIds = [];
  for (const companion of companions) {
    const name = firstText(companion.name);
    if (!name) continue;
    let photoUrl = firstFileUrl(companion.photoUrl);
    if (!photoUrl && companion.photoDataUrl) {
      photoUrl = await uploadOperatorBubbleFile(session, companion.photoDataUrl, {
        attachTo: movement.id,
        filename: `acompanante-${movement.id}-${createdIds.length + 1}-${Date.now()}.jpg`
      });
    }
    const created = await createOperatorDataItem(session, 'accesomovimiento', {
      movimiento_padre_custom_accesomovimiento: movement.id,
      acceso_custom_accesos: accessId,
      residente_custom_accesoresidentes: firstText(payload.resident_id),
      nombre_responsable_text: name,
      telefono_responsable_text: firstText(companion.phone, payload.telefono),
      id_frontal_file: photoUrl,
      Estatus: payload.status === 'Pendiente' ? 'Pendiente' : 'Ingresado',
      tipo_transporte_option_tipo_transporte: 'persona',
      razon_acceso_option_razon_acceso_os: operatorMovementTypeOption(payload.movement_type),
      horaentrada_date: new Date().toISOString()
    });
    const id = firstThingId(created);
    if (id) createdIds.push(id);
  }
  return createdIds;
}

function normalizeOperatorCompanionPayload(value) {
  if (!value) return [];
  const raw = typeof value === 'string'
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    })()
    : value;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    id: firstText(item?.id),
    name: firstText(item?.name),
    phone: firstText(item?.phone),
    photoDataUrl: firstText(item?.photoDataUrl),
    photoUrl: firstFileUrl(item?.photoUrl)
  })).filter((item) => item.name || item.photoDataUrl || item.photoUrl);
}

async function egressOperatorCloudMovement(session, movementId, payload = {}) {
  const accessId = firstText(payload.access_id, payload.access, payload.id_acceso);
  if (!accessId) {
    const error = new Error('El acceso es obligatorio para egresar movimientos.');
    error.status = 400;
    throw error;
  }
  const method = String(config.operator.egressMovementMethod || 'POST').toUpperCase();
  const exitPhotoDataUrl = firstText(payload.exit_photo_data_url, payload.vehicle_exit_photo_data_url);
  let exitFileUrl = '';
  const bodyPayload = {
    movement_id: movementId,
    access_id: accessId,
    control_point_id: firstText(
      payload.control_point_id,
      payload.control_point,
      payload.id_punto_control
    ),
    operator_name: firstText(payload.operator_name),
    camera: firstText(payload.camera)
  };
  if (exitPhotoDataUrl) {
    try {
      exitFileUrl = await uploadOperatorBubbleFile(session, exitPhotoDataUrl, {
        attachTo: movementId,
        filename: `salida-${movementId}-${Date.now()}.jpg`
      });
      Object.assign(bodyPayload, {
        exit_photo_url: exitFileUrl,
        exit_image_url: exitFileUrl,
        imagen_salida_file: exitFileUrl,
        vehicle_exit_photo_url: exitFileUrl
      });
    } catch (error) {
      await log('warn', 'No se pudo subir fotografia de salida; el egreso continuara sin foto', {
        movementId,
        error: error.message
      });
    }
  }
  const baseUrl = operatorWorkflowUrl(config.operator.egressMovementEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error' || body?.response?.ok === false) {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo egresar el movimiento en EOLO.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  if (exitFileUrl) {
    await persistOperatorExitPhoto(session, movementId, exitFileUrl).catch(async (error) => {
      await log('warn', 'No se pudo persistir fotografia de salida por Data API', {
        movementId,
        error: error.message,
        status: error.status
      });
    });
  }
  const normalizedMovement = normalizeOperatorMovement(body, accessId);
  if (normalizedMovement) {
    return {
      ...normalizedMovement,
      exit_image: normalizedMovement.exit_image || exitFileUrl
    };
  }
  return {
    id: movementId,
    uid_bubble: movementId,
    folio_display: movementId,
    accessId,
    status: 'Egresado',
    fecha_salida: new Date().toISOString(),
    can_exit: false,
    can_edit: false,
    exit_image: exitFileUrl,
    raw: body
  };
}

async function persistOperatorExitPhoto(session, movementId, exitFileUrl) {
  const id = firstText(movementId);
  const fileUrl = firstFileUrl(exitFileUrl);
  if (!id || !fileUrl) return {};
  return tryOperatorDataPayloads(
    (candidate) => patchOperatorDataItem(session, 'accesomovimiento', id, candidate),
    [
      { imagen_salida_file: fileUrl },
      { ImagenVehiculoSalida: fileUrl },
      { imagen_vehiculo_salida_file: fileUrl },
      { 'Imagen Salida': fileUrl },
      { exit_image: fileUrl },
      { exit_image_url: fileUrl },
      { vehicle_exit_photo_url: fileUrl }
    ]
  );
}

function pendingOperatorMovementsPath() {
  return path.join(config.dataDir, 'operator-pending-movements.json');
}

function pendingOperatorAssetsDir() {
  return path.join(config.dataDir, 'operator-pending-assets');
}

function pendingOperatorAssetPath(fileName) {
  return path.join(pendingOperatorAssetsDir(), path.basename(fileName));
}

async function loadPendingOperatorMovements() {
  try {
    const raw = await fs.promises.readFile(pendingOperatorMovementsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function savePendingOperatorMovements(items) {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const filePath = pendingOperatorMovementsPath();
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(items, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

async function createPendingOperatorMovement(payload, accessId, controlPointId, error) {
  const id = `local-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const storedPayload = { ...payload };
  const normalizedStoredPlate = normalizeOperatorPlate(firstText(storedPayload.placa, storedPayload.placas));
  const normalizedStoredVisitor = normalizeOperatorPersonName(
    firstText(storedPayload.visitor_name, storedPayload.nombre_visitante, storedPayload.nombre_responsable)
  );
  if (normalizedStoredPlate) {
    storedPayload.placa = normalizedStoredPlate;
    storedPayload.placas = normalizedStoredPlate;
  }
  if (normalizedStoredVisitor) {
    storedPayload.visitor_name = normalizedStoredVisitor;
    storedPayload.nombre_visitante = normalizedStoredVisitor;
  }
  const photo = parseDataUrl(payload.id_photo_data_url || payload.identification_photo_data_url);
  const vehiclePhoto = parseDataUrl(payload.vehicle_photo_data_url || payload.entry_photo_data_url);
  const companions = normalizeOperatorCompanionPayload(payload.companions || payload.companions_json);
  let photoFile = '';
  let photoMimeType = '';
  let vehiclePhotoFile = '';
  let vehiclePhotoMimeType = '';
  const storedCompanions = [];
  if (photo) {
    const extension = photo.mimeType === 'image/png' ? 'png' : 'jpg';
    photoFile = `${id}-id.${extension}`;
    photoMimeType = photo.mimeType;
    await fs.promises.mkdir(pendingOperatorAssetsDir(), { recursive: true });
    await fs.promises.writeFile(pendingOperatorAssetPath(photoFile), Buffer.from(photo.base64, 'base64'));
    delete storedPayload.id_photo_data_url;
    delete storedPayload.identification_photo_data_url;
  }
  if (vehiclePhoto) {
    const extension = vehiclePhoto.mimeType === 'image/png' ? 'png' : 'jpg';
    vehiclePhotoFile = `${id}-vehicle.${extension}`;
    vehiclePhotoMimeType = vehiclePhoto.mimeType;
    await fs.promises.mkdir(pendingOperatorAssetsDir(), { recursive: true });
    await fs.promises.writeFile(pendingOperatorAssetPath(vehiclePhotoFile), Buffer.from(vehiclePhoto.base64, 'base64'));
    delete storedPayload.vehicle_photo_data_url;
    delete storedPayload.entry_photo_data_url;
  }
  for (const [index, companion] of companions.entries()) {
    const companionPhoto = parseDataUrl(companion.photoDataUrl);
    let companionPhotoFile = '';
    let companionPhotoMimeType = '';
    if (companionPhoto) {
      const extension = companionPhoto.mimeType === 'image/png' ? 'png' : 'jpg';
      companionPhotoFile = `${id}-companion-${index + 1}.${extension}`;
      companionPhotoMimeType = companionPhoto.mimeType;
      await fs.promises.mkdir(pendingOperatorAssetsDir(), { recursive: true });
      await fs.promises.writeFile(
        pendingOperatorAssetPath(companionPhotoFile),
        Buffer.from(companionPhoto.base64, 'base64')
      );
    }
    storedCompanions.push({
      name: normalizeOperatorPersonName(companion.name),
      phone: companion.phone,
      photoUrl: companion.photoUrl,
      photoFile: companionPhotoFile,
      photoMimeType: companionPhotoMimeType
    });
  }
  if (storedCompanions.length) storedPayload.companions = JSON.stringify(storedCompanions);
  const movementPayload = buildOperatorMovementPayload(payload, accessId, controlPointId);
  const movement = pendingPayloadToMovement({
    id,
    payload: movementPayload,
    rawPayload: storedPayload,
    accessId,
    controlPointId,
    createdAt: now,
    photoFile,
    photoMimeType,
    vehiclePhotoFile,
    vehiclePhotoMimeType,
    companions: storedCompanions
  });
  const pending = {
    id,
    accessId,
    controlPointId,
    payload: storedPayload,
    movement,
    photoFile,
    photoMimeType,
    vehiclePhotoFile,
    vehiclePhotoMimeType,
    companions: storedCompanions,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lastAttemptAt: null,
    nextAttemptAt: now,
    lastError: error?.message || ''
  };
  const items = await loadPendingOperatorMovements();
  items.unshift(pending);
  await savePendingOperatorMovements(items);
  return pending;
}

function pendingPayloadToMovement({
  id,
  payload,
  rawPayload,
  accessId,
  controlPointId,
  createdAt,
  photoFile,
  photoMimeType,
  vehiclePhotoFile,
  vehiclePhotoMimeType,
  companions = []
}) {
  const source = payload || rawPayload || {};
  return {
    id,
    uid_bubble: '',
    folio_display: firstText(source.id2_text, source.id2, rawPayload?.id2_text, rawPayload?.id2) || id,
    accessId,
    controlPointId,
    local_pending: true,
    pending_sync: true,
    visitor_name: firstText(source.visitor_name, rawPayload?.visitor_name) || 'Visitante',
    telefono: firstText(source.telefono, rawPayload?.telefono),
    placa: firstText(source.placa, source.placas, rawPayload?.placa),
    notes: firstText(source.notes, rawPayload?.notes),
    visit_to: firstText(source.visit_to, rawPayload?.visit_to),
    resident_id: firstText(source.resident_id, rawPayload?.resident_id),
    area: firstText(source.area, rawPayload?.area),
    kind: firstText(source.kind, rawPayload?.kind) || 'Vehiculo',
    movement_type: firstText(source.movement_type, rawPayload?.movement_type) || 'Visita',
    status: 'Pendiente Sync',
    fecha_entrada: createdAt,
    fecha_salida: '',
    entry_image: vehiclePhotoFile ? `/api/operator/pending-movements/${encodeURIComponent(id)}/vehicle-photo` : '',
    id_image: photoFile
      ? `/api/operator/pending-movements/${encodeURIComponent(id)}/photo`
      : firstFileUrl(source.id_photo_url, rawPayload?.id_photo_url),
    id_photo_data_url: '',
    photoMimeType,
    vehiclePhotoMimeType,
    companions: Array.isArray(companions) ? companions : [],
    can_exit: false,
    can_edit: false,
    raw: { local_pending: true, payload: source }
  };
}

function publicPendingOperatorMovement(item) {
  return {
    id: item.id,
    accessId: item.accessId,
    controlPointId: item.controlPointId,
    status: item.status || 'pending',
    attempts: item.attempts || 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastAttemptAt: item.lastAttemptAt,
    nextAttemptAt: item.nextAttemptAt,
    lastError: item.lastError || '',
    hasPhoto: Boolean(item.photoFile),
    hasVehiclePhoto: Boolean(item.vehiclePhotoFile),
    companionCount: Array.isArray(item.companions) ? item.companions.length : 0,
    movement: item.movement || pendingPayloadToMovement(item)
  };
}

async function syncPendingOperatorMovements(session, { force = false } = {}) {
  const startedAt = new Date();
  const items = await loadPendingOperatorMovements();
  const remaining = [];
  const synced = [];
  const failed = [];
  let stoppedByOffline = false;

  for (const item of items) {
    if (!force && item.nextAttemptAt && Date.parse(item.nextAttemptAt) > startedAt.getTime()) {
      remaining.push(item);
      continue;
    }
    const payload = await payloadForPendingOperatorMovement(item);
    try {
      const createdMovement = await createOperatorCloudMovement(
        session,
        payload,
        item.accessId,
        item.controlPointId
      );
      synced.push({ id: item.id, movement: createdMovement });
      await removePendingOperatorAsset(item).catch(() => {});
    } catch (error) {
      const updated = {
        ...item,
        attempts: Number(item.attempts || 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        nextAttemptAt: new Date(Date.now() + 60 * 1000).toISOString(),
        lastError: error.message,
        updatedAt: new Date().toISOString()
      };
      failed.push({ id: item.id, error: error.message, retryable: isRetryableOperatorCloudError(error) });
      remaining.push(updated);
      if (isRetryableOperatorCloudError(error)) {
        stoppedByOffline = true;
        const index = items.indexOf(item);
        remaining.push(...items.slice(index + 1));
        break;
      }
    }
  }

  await savePendingOperatorMovements(remaining);
  if (synced.length) {
    await log('info', 'Movimientos pendientes de operador sincronizados con EOLO Cloud', {
      synced: synced.map((item) => item.id),
      remaining: remaining.length
    });
  }
  return {
    synced,
    failed,
    stoppedByOffline,
    pending: remaining.map(publicPendingOperatorMovement),
    pendingCount: remaining.length
  };
}

async function payloadForPendingOperatorMovement(item) {
  const payload = { ...(item.payload || {}) };
  if (item.photoFile) {
    const filePath = pendingOperatorAssetPath(item.photoFile);
    const base64 = await fs.promises.readFile(filePath, 'base64');
    payload.id_photo_data_url = `data:${item.photoMimeType || 'image/jpeg'};base64,${base64}`;
  }
  if (item.vehiclePhotoFile) {
    const filePath = pendingOperatorAssetPath(item.vehiclePhotoFile);
    const base64 = await fs.promises.readFile(filePath, 'base64');
    payload.vehicle_photo_data_url = `data:${item.vehiclePhotoMimeType || 'image/jpeg'};base64,${base64}`;
  }
  if (Array.isArray(item.companions) && item.companions.length) {
    const companions = [];
    for (const companion of item.companions) {
      let photoDataUrl = '';
      if (companion.photoFile) {
        const filePath = pendingOperatorAssetPath(companion.photoFile);
        const base64 = await fs.promises.readFile(filePath, 'base64');
        photoDataUrl = `data:${companion.photoMimeType || 'image/jpeg'};base64,${base64}`;
      }
      companions.push({
        name: companion.name || '',
        phone: companion.phone || '',
        photoUrl: companion.photoUrl || '',
        photoDataUrl
      });
    }
    payload.companions = JSON.stringify(companions);
  }
  return payload;
}

async function removePendingOperatorAsset(item) {
  const companionFiles = Array.isArray(item.companions)
    ? item.companions.map((companion) => companion.photoFile).filter(Boolean)
    : [];
  const files = [item.photoFile, item.vehiclePhotoFile, ...companionFiles].filter(Boolean);
  await Promise.all(files.map((file) => fs.promises.unlink(pendingOperatorAssetPath(file))));
}

function isRetryableOperatorCloudError(error = {}) {
  const status = Number(error.status || 0);
  if (!status) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function checkOperatorCloudAlive() {
  const checkedAt = new Date().toISOString();
  if (config.operator.authMode !== 'cloud') {
    return {
      online: false,
      configured: false,
      checkedAt,
      message: 'El operador esta en modo local.'
    };
  }
  const startedAt = Date.now();
  const method = String(config.operator.cloudStatusMethod || 'GET').toUpperCase();
  const bodyPayload = {
    bridge_time: checkedAt,
    source: 'operator_login'
  };
  const baseUrl = operatorWorkflowUrl(config.operator.cloudStatusEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  try {
    const response = await fetch(url, {
      method,
      headers: method === 'GET' ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
      signal: AbortSignal.timeout(5000)
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : { raw: await response.text().catch(() => '') };
    const protectedButReachable = response.status === 401 || response.status === 403;
    const online = response.ok ? body.status !== 'error' && body.ok !== false : protectedButReachable;
    return {
      online,
      configured: true,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      status: response.status,
      endpoint: config.operator.cloudStatusEndpoint,
      ...(protectedButReachable ? { message: 'EOLO Cloud respondio al endpoint protegido.' } : {}),
      ...(online ? {} : { error: bubbleErrorMessage(body, 'EOLO Cloud no respondio correctamente.') })
    };
  } catch (error) {
    return {
      online: false,
      configured: true,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      endpoint: config.operator.cloudStatusEndpoint,
      error: error.message
    };
  }
}

async function checkAnprAlive() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await fetch(`${config.anpr.baseUrl}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    const body = await response.json().catch(() => ({}));
    return {
      online: response.ok && body.ok !== false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      status: response.status,
      baseUrl: config.anpr.baseUrl,
      ...(response.ok ? {} : { error: body.error || response.statusText || 'ANPR no disponible' })
    };
  } catch (error) {
    return {
      online: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      baseUrl: config.anpr.baseUrl,
      error: error.message
    };
  }
}

async function fetchOperatorCloudPing(session) {
  const method = String(config.operator.cloudStatusMethod || 'GET').toUpperCase();
  const bodyPayload = {
    user_id: session.userId,
    bridge_time: new Date().toISOString()
  };
  const baseUrl = operatorWorkflowUrl(config.operator.cloudStatusEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(5000)
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : { raw: await response.text() };
  if (!response.ok || body.status === 'error' || body.ok === false) {
    const error = new Error(bubbleErrorMessage(body, 'EOLO Cloud no respondio correctamente.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return {
    serverTime: firstText(
      body.server_time,
      body.serverTime,
      body.response?.server_time,
      body.response?.serverTime
    ),
    status: firstText(body.status, body.response?.status) || 'ok'
  };
}

async function upsertOperatorCloudDeviceHeartbeat(session, { accessId = '' } = {}) {
  const deviceId = await operatorBridgeDeviceId();
  const checkedAt = new Date().toISOString();
  const method = String(config.operator.deviceHeartbeatMethod || 'POST').toUpperCase();
  const bodyPayload = {
    device_id: deviceId,
    sn: operatorBridgeSerial(),
    ...(accessId ? { access_id: accessId } : {})
  };
  const baseUrl = operatorWorkflowUrl(config.operator.deviceHeartbeatEndpoint);
  const url = method === 'GET' ? withQuery(baseUrl, bodyPayload) : baseUrl;
  const response = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${session.token}`
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(bodyPayload) }),
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.status === 'error' || body.ok === false) {
    const error = new Error(bubbleErrorMessage(body, 'No se pudo actualizar DispositivosAcceso.'));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const heartbeat = body.response || body || {};
  return {
    ok: true,
    action: 'workflow',
    id: firstText(heartbeat.device?._id, heartbeat.device?.id, heartbeat.id),
    deviceId,
    syncedAt: checkedAt,
    cloud: heartbeat
  };
}

async function operatorBridgeDeviceId() {
  const configured = firstText(config.operator.deviceId);
  if (configured) return normalizeBridgeDeviceId(configured);
  const filePath = path.join(config.dataDir, 'bridge-device-id');
  try {
    const saved = (await fs.promises.readFile(filePath, 'utf8')).trim();
    if (saved) return normalizeBridgeDeviceId(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generated = normalizeBridgeDeviceId(`eolo-bridge-${operatorMachineFingerprint()}`);
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  await fs.promises.writeFile(filePath, `${generated}\n`, 'utf8');
  return generated;
}

async function ensureOperatorMovementLocalId2(payload = {}, accessId = '') {
  const existing = normalizeOperatorMovementId2(
    firstText(payload.id2_text, payload.id2, payload.folio_display, payload.folio)
  );
  if (existing) {
    return {
      ...payload,
      id2_text: existing,
      id2: existing,
      folio_display: existing
    };
  }
  const accessPrefix =
    normalizeOperatorId2Prefix(
      firstText(
        payload.access_id2,
        payload.accessId2,
        payload.id2_acceso,
        payload.acceso_id2,
        payload.access_id2_text,
        payload.acceso_id2_text
      )
    ) || fallbackOperatorId2Prefix(accessId);
  const deviceId = await operatorBridgeDeviceId();
  const deviceCode = operatorId2DeviceCode(deviceId);
  const counter = await nextOperatorId2Counter(accessId, accessPrefix, deviceCode);
  const id2 = `${accessPrefix}${deviceCode}${String(counter).padStart(5, '0')}`;
  return {
    ...payload,
    access_id2: accessPrefix,
    id2_text: id2,
    id2,
    folio_display: id2,
    origen_id2_text: 'local_bridge',
    dispositivo_id_text: deviceId
  };
}

function operatorId2CountersPath() {
  return path.join(config.dataDir, 'operator-id2-counters.json');
}

async function nextOperatorId2Counter(accessId = '', accessPrefix = '', deviceCode = '') {
  const key = [normalizeBridgeDeviceId(accessId) || 'access', accessPrefix || 'AC', deviceCode || '00'].join(':');
  const run = operatorId2CounterQueue.then(async () => {
    const state = await loadOperatorId2Counters();
    const current = Number(state.counters?.[key] || 0);
    const next = current + 1;
    state.counters = { ...(state.counters || {}), [key]: next };
    state.updatedAt = new Date().toISOString();
    await saveOperatorId2Counters(state);
    return next;
  });
  operatorId2CounterQueue = run.catch(() => {});
  return run;
}

async function loadOperatorId2Counters() {
  try {
    const raw = await fs.promises.readFile(operatorId2CountersPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { counters: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { counters: {} };
    throw error;
  }
}

async function saveOperatorId2Counters(state) {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const filePath = operatorId2CountersPath();
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

function normalizeOperatorId2Prefix(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8);
}

function normalizeOperatorMovementId2(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toUpperCase()
    .slice(0, 32);
}

function normalizeOperatorPermissionId2(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 64);
}

function isCurrentOperatorPermissionId2(value) {
  return /(?:VV|VR|PR|PV)\d{14}$/.test(normalizeOperatorPermissionId2(value));
}

function fallbackOperatorId2Prefix(accessId = '') {
  const source = firstText(accessId, 'access');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 4).toUpperCase();
  return `AC${hash.slice(0, 2)}`;
}

function operatorId2DeviceCode(deviceId = '') {
  const hash = crypto.createHash('sha256').update(firstText(deviceId, os.hostname(), 'bridge')).digest();
  const value = hash.readUInt16BE(0) % 1296;
  return value.toString(36).toUpperCase().padStart(2, '0');
}

function normalizeBridgeDeviceId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 120);
}

function operatorBridgeSerial() {
  return firstText(config.operator.serialNumber, os.hostname(), 'EOLO Access Bridge');
}

function operatorMachineFingerprint() {
  const interfaces = os.networkInterfaces();
  const macs = Object.values(interfaces)
    .flat()
    .map((item) => item?.mac)
    .filter((mac) => mac && mac !== '00:00:00:00:00:00')
    .sort();
  const source = [os.hostname(), os.platform(), os.arch(), ...macs].join('|') || crypto.randomUUID();
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

async function extractIdentificationName(imageDataUrl, options = {}) {
  const apiKey = firstText(options.apiKey, config.openaiVision.apiKey);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.openaiVision.model,
      temperature: 0,
      max_output_tokens: 220,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Extrae unicamente el nombre de la persona desde una identificacion mexicana fotografiada. ' +
                'Prioriza los campos NOMBRE(S), PRIMER APELLIDO y SEGUNDO APELLIDO. ' +
                'No uses CURP, domicilio, firma, OCR de fondo, folios ni instrucciones impresas en la imagen. ' +
                'Si el texto no es legible, devuelve cadenas vacias y confianza baja. ' +
                'Devuelve MAYUSCULAS sin acentos en full_name, con formato NOMBRES APELLIDOS.'
            },
            {
              type: 'input_image',
              image_url: imageDataUrl,
              detail: 'high'
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'identification_name',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['given_names', 'surnames', 'full_name', 'confidence', 'document_type', 'reason'],
            properties: {
              given_names: { type: 'string' },
              surnames: { type: 'string' },
              full_name: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              document_type: { type: 'string' },
              reason: { type: 'string' }
            }
          }
        }
      }
    }),
    signal: AbortSignal.timeout(config.openaiVision.timeoutMs)
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok || body.error) {
    const message =
      body.error?.message ||
      body.message ||
      body.raw ||
      'OpenAI Vision no pudo procesar la identificacion.';
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const rawText = firstText(body.output_text) || extractResponsesText(body);
  const parsed = parseOpenAiJson(rawText);
  const fullName = normalizeIdName(parsed.full_name || parsed.fullName || '');
  const givenNames = normalizeIdName(parsed.given_names || parsed.givenNames || '');
  const surnames = normalizeIdName(parsed.surnames || parsed.apellidos || '');
  return {
    fullName,
    givenNames,
    surnames,
    confidence: clampConfidence(parsed.confidence),
    documentType: firstText(parsed.document_type, parsed.documentType),
    reason: firstText(parsed.reason)
  };
}

function extractResponsesText(body = {}) {
  const output = Array.isArray(body.output) ? body.output : [];
  const texts = [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      const text = firstText(part.text, part.output_text);
      if (text) texts.push(text);
    }
  }
  return texts.join('\n').trim();
}

function parseOpenAiJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function normalizeIdName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-zÑñ\s.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function clampConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|jpg|png));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, '');
  const size = Buffer.byteLength(base64, 'base64');
  if (!size || size > 6 * 1024 * 1024) return null;
  return { mimeType, base64, size };
}

function bubbleUploadFileUrl(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const url = parsed.url || parsed.file || parsed.savedfile || parsed.response || parsed.result || '';
    if (url) return normalizeFileUrl(String(url).trim());
  } catch {
    // Bubble commonly returns the uploaded file URL as text/plain.
  }
  return normalizeFileUrl(text.replace(/^"|"$/g, ''));
}

function buildOperatorMovementPayload(payload = {}, accessId, controlPointId) {
  const value = (...keys) => firstText(keys.map((key) => payload[key]).find((item) => item !== undefined));
  const rawKind = value('kind', 'tipo_transporte') || 'Vehiculo';
  const kind = /peat|persona|pax/i.test(rawKind) ? 'Peaton' : 'Vehiculo';
  const movementType = value('movement_type', 'razon_acceso') || 'Visita';
  const controlPointAction = value('control_point_action', 'tipo_accion', 'Tipo Accion');
  const controlPointActionMode = value('control_point_action_mode');
  const statusByAction =
    /author|autor|solicit/i.test(controlPointActionMode) || /autor|solicit/i.test(controlPointAction)
      ? 'Pendiente'
      : 'Ingresado';
  const defaultVehicleType = kind === 'Vehiculo' ? 'Automovil' : '';
  const defaultVehicleCategory = kind === 'Vehiculo' ? 'Sedan' : '';
  const vehicleDescription = [
    value('vehicle_type', 'tipo_vehiculo') || defaultVehicleType,
    value('vehicle_category', 'categoria_vehiculo') || defaultVehicleCategory,
    value('brand', 'marca'),
    value('model', 'modelo'),
    value('color'),
    value('vehicle_year', 'year', 'ano')
  ].filter(Boolean).join(' ');
  const plate = normalizeOperatorPlate(value('placa', 'placas'));
  const visitorName = normalizeOperatorPersonName(value('visitor_name', 'nombre_visitante', 'nombre_responsable'));
  return {
    access_id: accessId,
    control_point_id: controlPointId,
    id_acceso: accessId,
    id_punto_control: controlPointId,
    kind,
    tipo_transporte: kind,
    movement_type: movementType,
    razon_acceso: movementType,
    id2_text: normalizeOperatorMovementId2(value('id2_text', 'id2', 'folio_display', 'folio')),
    id2: normalizeOperatorMovementId2(value('id2', 'id2_text', 'folio_display', 'folio')),
    access_id2: normalizeOperatorId2Prefix(value('access_id2', 'accessId2', 'id2_acceso', 'acceso_id2')),
    origen_id2_text: value('origen_id2_text'),
    dispositivo_id_text: value('dispositivo_id_text'),
    placa: plate,
    placas: plate,
    economic_number: value('economic_number', 'n_economico'),
    n_economico: value('n_economico', 'economic_number'),
    vehicle_type: value('vehicle_type', 'tipo_vehiculo') || defaultVehicleType,
    tipo_vehiculo: value('tipo_vehiculo', 'vehicle_type') || defaultVehicleType,
    vehicle_category: value('vehicle_category', 'categoria_vehiculo') || defaultVehicleCategory,
    categoria_vehiculo: value('categoria_vehiculo', 'vehicle_category') || defaultVehicleCategory,
    vehicle_description: value('vehicle_description', 'descripcionvehiculo') || vehicleDescription,
    descripcionvehiculo: value('descripcionvehiculo', 'vehicle_description') || vehicleDescription,
    vehicle_year: value('vehicle_year', 'year', 'ano'),
    color: value('color'),
    brand: value('brand', 'marca'),
    marca: value('marca', 'brand'),
    model: value('model', 'modelo'),
    modelo: value('modelo', 'model'),
    telefono: value('telefono', 'phone'),
    phone: value('phone', 'telefono'),
    notes: value('notes', 'nota', 'referencia'),
    nota: value('nota', 'notes', 'referencia'),
    visitor_name: visitorName,
    nombre_visitante: visitorName,
    visit_to: value('visit_to', 'a_quien_visita', 'visita_a'),
    a_quien_visita: value('a_quien_visita', 'visit_to', 'visita_a'),
    resident_id: value('resident_id', 'residente_id', 'id_residente'),
    permiso_acceso_id: value('permiso_acceso_id', 'permisoacceso_id', 'source_permission_id'),
    permisoacceso_id: value('permisoacceso_id', 'permiso_acceso_id', 'source_permission_id'),
    source_permission_id: value('source_permission_id', 'permiso_acceso_id', 'permisoacceso_id'),
    permiso_acceso_id2: normalizeOperatorPermissionId2(value('permiso_acceso_id2', 'permission_id2')),
    permission_id2: normalizeOperatorPermissionId2(value('permission_id2', 'permiso_acceso_id2')),
    usuario_id: value('usuario_id', 'permission_user_id'),
    permission_user_id: value('permission_user_id', 'usuario_id'),
    vehicle_id: value('vehicle_id', 'vehiculo_id', 'id_vehiculo'),
    driver_id: value('driver_id', 'conductor_id', 'id_conductor'),
    driver_mode: value('driver_mode'),
    vehicle_driver_ids: value('vehicle_driver_ids'),
    area: value('area'),
    punto_control_name: value('punto_control_name'),
    control_point_action: controlPointAction,
    control_point_action_mode: controlPointActionMode,
    operator_name: value('operator_name'),
    status: value('status') || statusByAction,
    id_photo_data_url: value('id_photo_data_url', 'identification_photo_data_url'),
    identification_photo_data_url: value('identification_photo_data_url', 'id_photo_data_url'),
    id_photo_url: value('id_photo_url', 'identification_photo_url'),
    face_image_url: value('face_image_url', 'imagen_rostro_url'),
    imagen_rostro_url: value('imagen_rostro_url', 'face_image_url'),
    vehicle_photo_data_url: value('vehicle_photo_data_url', 'entry_photo_data_url'),
    entry_photo_data_url: value('entry_photo_data_url', 'vehicle_photo_data_url'),
    vehicle_photo_url: value('vehicle_photo_url', 'entry_image_url'),
    entry_image_url: value('entry_image_url', 'vehicle_photo_url'),
    image: value('image', 'imagen', 'vehicle_photo_url', 'entry_image_url'),
    imagen: value('imagen', 'image', 'vehicle_photo_url', 'entry_image_url'),
    inspection_notes: value('inspection_notes', 'inspeccion'),
    inspeccion: value('inspeccion', 'inspection_notes'),
    companions_json: value('companions', 'companions_json'),
    face_employee_no: value('face_employee_no'),
    face_device_id: value('face_device_id'),
    face_device_type: value('face_device_type'),
    face_device_name: value('face_device_name'),
    face_event_serial: value('face_event_serial'),
    face_event_type: value('face_event_type'),
    face_verify_mode: value('face_verify_mode'),
    card_number: value('card_number', 'numero_tarjeta'),
    numero_tarjeta: value('numero_tarjeta', 'card_number'),
    qr_code: value('qr_code', 'codigo_qr'),
    codigo_qr: value('codigo_qr', 'qr_code'),
    source: value('source')
  };
}

function filterOperatorMovements(movements, query = {}) {
  const search = String(query.search || '').trim().toLowerCase();
  const status = String(query.status || '').trim().toLowerCase();
  const kind = String(query.kind || '').trim().toLowerCase();
  const dateFrom = parseOperatorDateBoundary(query.date_from, 'start');
  const dateTo = parseOperatorDateBoundary(query.date_to || query.date, 'end');
  return movements.filter((movement) => {
    if (status && String(movement.status || '').toLowerCase() !== status) return false;
    if (kind && String(movement.kind || '').toLowerCase() !== kind) return false;
    const movementDate = parseOperatorDateValue(movement.created_at || movement.fecha_entrada);
    if (dateFrom && movementDate && movementDate < dateFrom) return false;
    if (dateTo && movementDate && movementDate > dateTo) return false;
    if (!search) return true;
    const haystack = [
      movement.visitor_name,
      movement.folio_display,
      movement.uid_bubble,
      movement.placa,
      movement.notes,
      movement.visit_to,
      movement.area,
      movement.telefono
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(search);
  });
}

function sortOperatorMovements(movements, query = {}) {
  const sort = String(query.sort || 'modified_desc').trim().toLowerCase();
  if (sort !== 'modified_desc') return movements;
  return [...movements].sort((a, b) => {
    const bDate = parseOperatorDateValue(b.modified_at || b.created_at || b.fecha_entrada);
    const aDate = parseOperatorDateValue(a.modified_at || a.created_at || a.fecha_entrada);
    return (bDate?.getTime() || 0) - (aDate?.getTime() || 0);
  });
}

function paginateOperatorMovements(movements, query = {}) {
  const limit = movementPageLimit(query.limit);
  const offset = movementPageOffset(query.offset);
  return movements.slice(offset, offset + limit);
}

function movementPageLimit(value) {
  const parsed = Number.parseInt(value || '10', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 100);
}

function movementPageOffset(value) {
  const parsed = Number.parseInt(value || '0', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseOperatorDateBoundary(value, boundary = 'start') {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}`);
  }
  return parseOperatorDateValue(text);
}

function normalizeBubbleDateParam(value, boundary = 'start') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return `${text}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}`;
  }
  return text;
}

function parseOperatorDateValue(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value);
  const text = String(value).trim();
  if (/^\d{12,}$/.test(text)) return new Date(Number(text));
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000);
  const date = new Date(text.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function summarizeOperatorMovements(movements) {
  return movements.reduce(
    (summary, movement) => {
      if (movement.status === 'Ingresado') {
        if (movement.kind === 'Peaton') summary.pedestrians += 1;
        else summary.vehicles += 1;
      }
      return summary;
    },
    { vehicles: 0, pedestrians: 0 }
  );
}

function normalizeOperatorResidents(body, fallbackAccessId = '') {
  const response = body?.response || body || {};
  const list =
    response.residents ||
    response.residentes ||
    response.acceso_residentes ||
    response.accesoresidentes ||
    response['Acceso Residentes'] ||
    response.results ||
    (Array.isArray(response) ? response : []);
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const id = firstText(getField(item, 'id', '_id', 'unique_id', 'ID'));
      const name = firstText(
        getField(
          item,
          'name',
          'nombre',
          'nombre_text',
          'Nombre',
          'nombre_completo_text',
          'residente_text'
        )
      );
      const area = firstText(
        getField(item, 'area', 'Area', 'Área', 'departamento_text', 'Departamento', 'Empresa Text')
      );
      const phone = firstText(
        getField(item, 'phone', 'telefono', 'Telefono', 'Teléfono', 'telefono_text')
      );
      const company = firstText(getField(item, 'empresa', 'Empresa', 'empresa_text', 'Empresa Text'));
      const isArea = firstBoolean(
        getField(
          item,
          'isArea',
          'is_area',
          'EsArea',
          'esArea',
          'Es Area',
          'esarea_boolean',
          'isarea_boolean',
          'is_area_boolean'
        )
      );
      const access = getField(item, 'access_id', 'id_acceso', 'Acceso', 'acceso_custom_accesos');
      return {
        id,
        name: name || phone || id,
        area,
        phone,
        company,
        isArea,
        is_area: isArea,
        accessId: firstText(access) || fallbackAccessId,
        raw: item
      };
    })
    .filter((resident) => resident.id && resident.name);
}

function normalizeOperatorAccesses(body) {
  const response = body?.response || body || {};
  const list =
    response.accesses ||
    response.accesos ||
    response['Mis Accesos'] ||
    response.results ||
    (Array.isArray(response) ? response : []);
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const id = item.id || item._id || item.unique_id || item.acceso || item.Acceso || '';
    const accessOpenaiApiKey = firstText(
      item.auxkey1_text,
      item.AuxKey1,
      item.auxKey1,
      item.aux_key_1_text,
      item['AuxKey1'],
      item['Aux Key 1']
    );
    const name =
      item.name ||
      item.nombre ||
      item.nombre_text ||
      item.display ||
      item.title ||
      item.Nombre ||
      item['Nombre Acceso'] ||
      id ||
      config.operator.defaultAccessName;
    const team = item.team || item.Team || item.team_custom_team || '';
    const logo = firstFileUrl(
      item.logo,
      item.image,
      item.Logo,
      item.logo_acceso_image,
      item['Logo Acceso'],
      item.foto,
      item.Foto
    );
    const normalized = {
      id,
      name,
      description:
        item.description ||
        item.descripcion ||
        item.Descripcion ||
        item.razon_social_text ||
        '',
      company:
        item.company ||
        item.empresa ||
        item.Empresa ||
        item.cliente ||
        item.Cliente ||
        item.razon_social_text ||
        '',
      location:
        item.location ||
        item.ubicacion ||
        item.Ubicacion ||
        item.direccion ||
        item.direcci_n_geographic_address ||
        '',
      role: item.role || item.rol || item.Rol || '',
      vehicleAuxIdentifierLabel: firstText(
        item.vehicleAuxIdentifierLabel,
        item.identificadorauxiliarvehicular_text,
        item.IdentificadorAuxiliarVehicular,
        item.identificador_auxiliar_vehicular,
        item['Identificador Auxiliar Vehicular']
      ),
      id2: normalizeOperatorId2Prefix(firstText(item.id2, item.id2_text, item.ID2, item['ID 2'])),
      id2_text: normalizeOperatorId2Prefix(firstText(item.id2_text, item.id2, item.ID2, item['ID 2'])),
      team: typeof team === 'object' ? team._id || team.id || '' : team,
      logo,
      openaiVisionKeySet: Boolean(accessOpenaiApiKey),
      openaiVisionKeySource: accessOpenaiApiKey ? 'access' : 'local-fallback',
      active: item.active ?? item.activo_boolean ?? item.Activo ?? true,
      raw: redactOperatorAccessSecrets(item)
    };
    Object.defineProperty(normalized, 'accessOpenaiApiKey', {
      value: accessOpenaiApiKey,
      enumerable: false
    });
    return normalized;
  });
}

function redactOperatorAccessSecrets(item = {}) {
  if (!item || typeof item !== 'object') return item;
  const redacted = { ...item };
  for (const key of Object.keys(redacted)) {
    if (/aux_?key_?1|auxkey1/i.test(key)) {
      redacted[key] = redacted[key] ? '[redacted]' : redacted[key];
    }
  }
  return redacted;
}

function normalizeOperatorMovements(body, fallbackAccessId = '') {
  const response = body?.response || body || {};
  const list =
    response.movements ||
    response.acceso_movimientos ||
    response.accesomovimientos ||
    response['Acceso Movimientos'] ||
    response.results ||
    (Array.isArray(response) ? response : []);
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const id = firstText(
      getField(item, 'id', '_id', 'unique_id', 'ID', 'Folio', 'folio', 'folio_text')
    );
    const access = getField(item, 'accessId', 'access_id', 'id_acceso', 'Acceso', 'acceso_custom_accesos');
    const entryAt = firstText(
      getField(
        item,
        'fecha_entrada',
        'Fecha Entrada',
        'Entrada',
        'FechaEntrada',
        'horaentrada_date',
        'ingreso_date',
        'Ingreso',
        'Created Date'
      )
    );
    const exitAt = firstText(
      getField(
        item,
        'fecha_salida',
        'Fecha Salida',
        'Salida',
        'FechaSalida',
        'horasalida_date',
        'egreso_date',
        'Egreso'
      )
    );
    const createdAt = firstText(getField(item, 'created_at', 'Created Date', 'creation_date'));
    const modifiedAt = firstText(
      getField(item, 'modified_at', 'Modified Date', 'modified_date', 'updated_at', 'Updated Date')
    );
    const statusText = firstText(
      getField(
        item,
        'status',
        'Estatus',
        'Estatus Actual',
        'estatus',
        'estatus_text',
        'estatus_option_estatus_acceso_os'
      )
    );
    const status = normalizeMovementStatus(statusText, entryAt, exitAt);
    const kindText = firstText(
      getField(
        item,
        'kind',
        'Tipo Acceso',
        'Tipo',
        'tipo',
        'tipo_acceso',
        'Tipo_Transporte',
        'tipo_transporte_option_tipo_transporte',
        'tipo_acceso_option_tipo_acceso_control'
      )
    );
    const kind = /peat|pax|persona/i.test(kindText) ? 'Peaton' : 'Vehiculo';
    const resident = getField(
      item,
      'resident',
      'resident_id',
      'residente_custom_accesoresidentes',
      'Residente',
      'ResidenteVisitado'
    );
    return {
      id: id || item._id || '',
      uid_bubble: item._id || id || '',
      folio_display:
        firstText(getField(item, 'id2_text', 'id2', 'ID2', 'ID 2', 'folio_display', 'Folio', 'folio', 'id_display')) ||
        id ||
        item._id ||
        '',
      accessId: typeof access === 'object' ? access._id || access.id || fallbackAccessId : access || fallbackAccessId,
      controlPointId: firstText(
        getField(
          item,
          'id_punto_control',
          'Punto Control',
          'Punto de Control',
          'PuntoControl',
          'punto_custom_accesoconfiguracion',
          'puntocontrol_custom_accesoconfiguracion',
          'AccesoConfiguracion',
          'accesoconfiguracion_custom_accesoconfiguracion'
        )
      ),
      visitor_name: firstText(
        getField(
          item,
          'visitor_name',
          'Nombre Completo Visitante',
          'Nombre Visitante',
          'Visitante',
          'Nombre',
          'nombre_text',
          'Nombre_Responsable',
          'nombre_responsable_text'
        )
      ),
      telefono: firstText(
        getField(
          item,
          'telefono',
          'Telefono',
          'Teléfono',
          'phone',
          'telefono_text',
          'Telefono_Responsable',
          'telefono_responsable_text'
        )
      ),
      movement_type:
        normalizeOperatorMovementType(firstText(
          getField(
            item,
            'movement_type',
            'Motivo de Ingreso',
            'Tipo Solicitud',
            'Tipo Movimiento',
            'Tipo Visita',
            'Razon Acceso',
            'Razón Acceso',
            'Razon_Acceso',
            'razon_acceso_option_razon_acceso_os'
          )
        )) || 'Visitante',
      kind,
      placa: firstText(getField(item, 'placa', 'Placa', 'Placas', 'placas_text', 'placa_text')),
      notes: firstText(
        getField(item, 'notes', 'Notas', 'Nota', 'Comentarios', 'nota_text', 'Referencia', 'referencia_text')
      ),
      visit_to: firstText(
        getField(item, 'visit_to', 'Visita A', 'A Quien Visita', 'A quien visita', 'Destino', 'ResidenteVisitado')
      ),
      area: firstText(getField(item, 'area', 'Area', 'Área', 'Departamento')),
      status,
      fecha_entrada: entryAt || createdAt,
      fecha_salida: exitAt,
      created_at: createdAt,
      modified_at: modifiedAt || createdAt || entryAt,
      economic_number: firstText(
        getField(
          item,
          'economic_number',
          'Número Económico',
          'Numero Economico',
          'Núm Económico',
          'N. Economico',
          'n__economico_text'
        )
      ),
      vehicle_type: firstText(
        getField(item, 'vehicle_type', 'Tipo Vehiculo', 'Tipo Vehículo', 'Tipo_Vehiculo', 'tipo_vehiculo1_option_tipo_vehiculo_os')
      ),
      vehicle_category: firstText(
        getField(item, 'vehicle_category', 'Categoría de Vehículo', 'Categoria_Vehiculo', 'categoria_vehiculo_option_capacidad_inspeccion_os')
      ),
      vehicle_description: firstText(
        getField(item, 'vehicle_description', 'descripcionvehiculo_text', 'Descripción Vehículo', 'Descripcion Vehiculo')
      ),
      vehicle_year: firstText(getField(item, 'vehicle_year', 'Año')),
      color: firstText(getField(item, 'color', 'Color')),
      brand: firstText(getField(item, 'brand', 'Marca')),
      model: firstText(getField(item, 'model', 'Modelo')),
      company_text: firstText(getField(item, 'company_text', 'empresa_text_text', 'Empresa')),
      box_1: firstText(getField(item, 'box_1', 'caja1_text', 'Caja 1')),
      box_2: firstText(getField(item, 'box_2', 'caja2_text', 'Caja 2')),
      approved_at: firstText(getField(item, 'approved_at', 'fechaautorizada_date', 'Fecha Autorizada')),
      entry_image: firstFileUrl(
        getField(
          item,
          'entry_image',
          'imagen_entrada_file',
          'ImagenVehiculoEntrada',
          'imagen_vehiculo_entrada_file',
          'Imagen Entrada'
        )
      ),
      exit_image: firstFileUrl(
        getField(
          item,
          'exit_image',
          'imagen_salida_file',
          'ImagenVehiculoSalida',
          'imagen_vehiculo_salida_file',
          'Imagen Salida'
        )
      ),
      id_image: firstFileUrl(
        getField(
          item,
          'id_image',
          'id_frontal_file',
          'ImagenIdentificacionEntrada',
          'identificacion_file',
          'identificacion_entrada_file',
          'Identificación'
        )
      ),
      package_entry_image: firstFileUrl(getField(item, 'package_entry_image', 'paquete_entrada_file', 'Paquete Entrada')),
      inspection_notes: firstText(
        getField(item, 'inspection_notes', 'inspeccion', 'inspeccion_text', 'Inspección', 'Inspeccion')
      ),
      authorization: firstText(
        getField(item, 'authorization', 'autorizacionlista_custom_autorizacionlista', 'Autorización')
      ),
      resident: firstText(resident),
      resident_id: firstThingId(resident),
      vehicle_id: firstThingId(getField(item, 'vehicle_id', 'vehiculo_custom_vehicle', 'Vehiculo')),
      driver: firstText(getField(item, 'driver', 'conductor_custom_conductor', 'Conductor')),
      driver_id: firstThingId(getField(item, 'driver_id', 'conductor_custom_conductor', 'Conductor')),
      companions: normalizeThingIdList(getField(item, 'companions', 'lista_acompa_antes_list_custom_accesomovimiento', 'Lista_Acompañantes')),
      can_exit: status === 'Ingresado',
      can_edit: status !== 'Egresado',
      raw: item
    };
  });
}

function normalizeOperatorMovement(body, fallbackAccessId = '') {
  const response = body?.response || body || {};
  const item =
    response.movement ||
    response.Movimiento ||
    response.movimiento ||
    response.acceso_movimiento ||
    response.accesomovimiento ||
    response.result ||
    (Array.isArray(response.movements) ? response.movements[0] : null) ||
    (Array.isArray(response.results) ? response.results[0] : null) ||
    (Array.isArray(response) ? response[0] : null);
  if (item && typeof item === 'object') {
    return normalizeOperatorMovements([item], fallbackAccessId)[0] || null;
  }
  const id = firstText(response.movement_id || response.id || response._id || response.unique_id);
  if (!id) return null;
  return {
    id,
    uid_bubble: id,
    folio_display: firstText(response.id2_text, response.id2, response.folio_display) || id,
    accessId: firstText(response.access_id) || fallbackAccessId,
    controlPointId: firstText(response.control_point_id),
    movement_type: normalizeOperatorMovementType(firstText(response.movement_type, response.razon_acceso)) || '',
    status: normalizeMovementStatus(response.status || 'Pendiente'),
    can_exit: normalizeMovementStatus(response.status || 'Pendiente') === 'Ingresado',
    can_edit: normalizeMovementStatus(response.status || 'Pendiente') !== 'Egresado',
    raw: response
  };
}

function getField(source, ...keys) {
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return '';
}

function firstThingId(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'object') {
      const id = value._id || value.id || value.unique_id || value.ID || value.uid || '';
      if (String(id).trim()) return String(id).trim();
    }
  }
  return '';
}

function firstBoolean(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim();
    if (/^(true|yes|si|sí|1)$/i.test(text)) return true;
    if (/^(false|no|0)$/i.test(text)) return false;
  }
  return false;
}

function firstBooleanOrDefault(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim();
  if (/^(true|yes|si|sí|1)$/i.test(text)) return true;
  if (/^(false|no|0)$/i.test(text)) return false;
  return fallback;
}

function firstFileUrl(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim()) return normalizeFileUrl(value.trim());
    if (typeof value === 'object') {
      const url = value.url || value.file || value.filename || value.src || value._url || '';
      if (String(url).trim()) return normalizeFileUrl(String(url).trim());
    }
  }
  return '';
}

function normalizeFileUrl(value) {
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function normalizeOperatorPlate(value) {
  return firstText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function operatorMovementTypeOption(value) {
  const text = firstText(value);
  if (/resident/i.test(text)) return 'residente';
  if (/serv/i.test(text)) return 'servicio';
  return 'visita';
}

function normalizeOperatorMovementType(value) {
  const text = firstText(value);
  if (/resident/i.test(text)) return 'Residente';
  if (/visit/i.test(text) || /visita/i.test(text)) return 'Visitante';
  if (/serv/i.test(text)) return 'Servicio';
  return text;
}

function normalizeOperatorPersonName(value) {
  return firstText(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizePlateForLookup(value) {
  return normalizeOperatorPlate(value);
}

function normalizeMovementStatus(value, entryAt = '', exitAt = '') {
  const text = firstText(value);
  if (/pend/i.test(text)) return 'Pendiente';
  if (/autor/i.test(text)) return 'Autorizado';
  if (/rechaz/i.test(text)) return 'Rechazado';
  if (/solicit/i.test(text)) return 'Solicitado';
  if (/egres|salid|afuera/i.test(text) || exitAt) return 'Egresado';
  if (/ingres|entrad|adentro/i.test(text) || entryAt) return 'Ingresado';
  return text || 'Solicitado';
}

function normalizeControlPointAction(value) {
  const text = firstText(value);
  if (/autor|solicit/i.test(text)) return 'authorize';
  if (/notific/i.test(text)) return 'notify';
  if (/registr/i.test(text)) return 'register';
  return 'register';
}

function normalizeOperatorControlPoints(body, fallbackAccessId = '') {
  const response = body?.response || body || {};
  const list =
    response.control_points ||
    response.controlPoints ||
    response.puntos_control ||
    response.puntosControl ||
    response.puntos ||
    response.results ||
    (Array.isArray(response) ? response : []);
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const access =
      item.accessId ||
      item.access_id ||
      item.acceso_id ||
      item.acceso_custom_accesos ||
      item.Acceso ||
      '';
    const orientation = firstText(
      item.name,
      item.nombre,
      item.orientacion_text,
      item.orientacion,
      item.Nombre
    );
    const rawCameras = Array.isArray(item.cameras)
      ? item.cameras
      : Array.isArray(item.camaras)
        ? item.camaras
        : Array.isArray(item.camaras_dt_list_custom_camara)
          ? item.camaras_dt_list_custom_camara
          : Array.isArray(item['Camaras DT'])
            ? item['Camaras DT']
            : [];
    const cameraIds = rawCameras
      .map((camera) => (typeof camera === 'string' ? camera : camera?._id || camera?.id || ''))
      .filter(Boolean);
    const cameras = rawCameras
      .filter((camera) => camera && typeof camera === 'object')
      .map((camera) => ({
        id: camera._id || camera.id || camera.unique_id || '',
        name: firstText(camera.name, camera.nombre, camera.Nombre, camera.nombre_text),
        type: firstText(camera.type, camera.tipo, camera.Tipo),
        prefix: firstText(camera.prefix, camera.prefijo, camera.Prefijo)
      }))
      .filter((camera) => camera.name);
    const actionType = item.actionType || item['Tipo Accion'] || item.tipo_accion_option_tipo_accion_control_os || '';
    const actionMode = normalizeControlPointAction(actionType);
    return {
      id:
        item.id ||
        item._id ||
        item.unique_id ||
        item.punto_control ||
        item.puntocontrol ||
        item.PuntoControl ||
        '',
      accessId: typeof access === 'object' ? access._id || access.id || fallbackAccessId : access || fallbackAccessId,
      name: orientation || 'Punto de control',
      type:
        item.type ||
        item.tipo ||
        item.Tipo ||
        item['Tipo Acceso'] ||
        item.tipo_acceso_option_tipo_acceso_control ||
        item.tipo_option_tipo_accesodoor_os ||
        '',
      actionType,
      actionMode,
      actionLabel:
        actionMode === 'authorize'
          ? 'Requiere autorización'
          : actionMode === 'notify'
            ? 'Notifica al residente'
            : 'Solo registra',
      requestType:
        item.requestType || item['Tipo Solicitud'] || item.tipo_solicitud_option_tipo_solicitud_control_os || '',
      address: item.address || item.direccion || item.Direccion || item.direccion_geographic_address || '',
      phone: item.phone || item.telefono || item.Telefono || item.telefono_text || '',
      entryCamera: item.entryCamera || item.camara1_text || '',
      exitCamera: item.exitCamera || item.barrera1_text || '',
      cameras,
      cameraIds,
      ringLevel: item.ringLevel || item['Nivel Anillo'] || '',
      hideInspection: item.hideInspection ?? item.OcultarInspeccion ?? false,
      active: item.active ?? item.activo ?? item.Activo ?? true,
      raw: item
    };
  });
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
      const text =
        value.display ||
        value.db_value ||
        value.value ||
        value.name ||
        value.Nombre ||
        value.text ||
        value.label ||
        value._id ||
        value.id ||
        '';
      if (String(text).trim()) return String(text).trim();
    }
  }
  return '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function operatorFromBubbleUser(user, fallback = {}) {
  const avatar = firstFileUrl(
    user.foto_perfil,
    user.Foto,
    user.foto,
    user.avatar,
    user.Avatar,
    user.profile_picture,
    user.picture,
    user.image
  );
  return {
    id: user._id || '',
    name:
      user.full_name ||
      user.nombre_comercial ||
      user['phone number'] ||
      fallback.phone ||
      config.operator.defaultName,
    company: user.nombre_comercial || user.razon_social || config.operator.defaultCompany,
    phone: user['phone number'] || fallback.phone || '',
    avatar,
    roles: user.Roles || [],
    loggedAt: new Date().toISOString()
  };
}

function bubbleErrorMessage(body, fallback) {
  return (
    body?.message ||
    body?.body?.message ||
    body?.reason ||
    body?.status ||
    fallback
  );
}

function stopCurrentStream() {
  if (config.mockDevice && device?.interval) {
    device.stopAutoEvents();
  }
  if (eventStream?.running) {
    eventStream.stop();
  }
}

async function startDeviceEventService() {
  if (config.mockDevice) {
    device.startAutoEvents();
    await log('info', 'Eventos mock iniciados');
    return { running: true, mode: 'mock' };
  }
  return eventStream.start();
}

async function stopDeviceEventService() {
  if (config.mockDevice) {
    device.stopAutoEvents();
    await log('info', 'Eventos mock detenidos');
    return { running: false, mode: 'mock' };
  }
  return eventStream.stop();
}

async function validateCurrentDevice() {
  return validateDeviceConfig({
    faceDevice: config.faceDevice,
    hikvision: config.hikvision,
    dahua: config.dahua
  }, config.mockDevice);
}

async function validateDeviceConfig(settings, mockDevice) {
  if (mockDevice) {
    return {
      ok: true,
      mode: 'mock',
      message: 'Modo prueba activo; no se contacto al dispositivo fisico.'
    };
  }

  try {
    const faceDevice = settings.faceDevice === 'dahua' ? 'dahua' : 'hikvision';
    const candidateSettings = faceDevice === 'dahua'
      ? {
        ...config.dahua,
        ...(settings.dahua || {}),
        port: Number(settings.dahua?.port || config.dahua.port)
      }
      : {
        ...config.hikvision,
        ...(settings.hikvision || settings),
        port: Number(settings.hikvision?.port || settings.port || config.hikvision.port)
      };
    const candidate = faceDevice === 'dahua'
      ? new DahuaClient(candidateSettings)
      : new HikvisionClient(candidateSettings);
    const deviceInfo = await candidate.deviceInfo({
      signal: AbortSignal.timeout(5000)
    });
    return {
      ok: true,
      mode: faceDevice,
      message: 'Respuesta valida del dispositivo.',
      deviceInfo
    };
  } catch (error) {
    const faceDevice = settings.faceDevice === 'dahua' ? 'dahua' : 'hikvision';
    const candidateSettings = faceDevice === 'dahua'
      ? { ...config.dahua, ...(settings.dahua || {}) }
      : { ...config.hikvision, ...(settings.hikvision || settings) };
    const diagnosis = describeDeviceValidationError(error, faceDevice, candidateSettings);
    return {
      ok: false,
      mode: faceDevice,
      message: diagnosis.message,
      error: error.message,
      status: error.status,
      target: diagnosis.target,
      detail: error.body
    };
  }
}

function describeDeviceValidationError(error, faceDevice, settings = {}) {
  const label = faceDevice === 'dahua' ? 'Dahua ASI' : 'Hikvision';
  const target = `${settings.protocol || 'http'}://${settings.host || 'sin-host'}:${Number(settings.port || 80)}`;
  const message = String(error.message || '');
  if (error.status === 401 || error.status === 403) {
    return {
      target,
      message: `${label} respondio en ${target}, pero rechazo las credenciales o permisos (${error.status}).`
    };
  }
  if (/aborted|timeout|timed out/i.test(message)) {
    return {
      target,
      message: `No se recibio respuesta valida de ${label} en ${target}; revisa IP, puerto y red local.`
    };
  }
  return {
    target,
    message: `No se pudo validar ${label} en ${target}.`
  };
}

function activeFaceDeviceSettings() {
  return config.faceDevice === 'dahua' ? config.dahua : config.hikvision;
}

function intInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
