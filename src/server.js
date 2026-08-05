import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HikvisionClient } from './hikvisionClient.js';
import { MockDevice } from './mockDevice.js';
import { EoloClient } from './eoloClient.js';
import { EoloUserSync } from './eoloUserSync.js';
import { DeviceEventStream } from './eventStream.js';
import { TaskRunner } from './taskRunner.js';
import { bus, ensureDataDirs, getEvents, getLogs, log } from './logger.js';
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
let device = createDevice();
let eventStream = createEventStream();
let taskRunner = new TaskRunner(device, eoloClient);
let eoloUserSync = new EoloUserSync(device, eoloClient);
const serviceManager = new ServiceManager();
registerServices();

app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

const asyncRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

async function fetchAnprJson(pathname, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;
  const response = await fetch(`${config.anpr.baseUrl}${pathname}`, {
    ...fetchOptions,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const error = new Error(payload.error || payload.detail || response.statusText);
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload;
}

app.get(
  '/api/health',
  asyncRoute(async (_req, res) => {
    res.json({
      ok: true,
      mode: config.mockDevice ? 'mock' : 'device',
      deviceHost: config.hikvision.host,
      devicePort: config.hikvision.port,
      deviceProtocol: config.hikvision.protocol,
      eoloConfigured: eoloClient.enabled,
      eoloUserSync: eoloUserSync.status(),
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
      host: config.hikvision.host,
      port: config.hikvision.port,
      protocol: config.hikvision.protocol,
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
    const submitted = req.body.hikvision || req.body;
    const candidate = {
      ...config.hikvision,
      ...submitted,
      password: submitted.password === '' ? config.hikvision.password : submitted.password
    };
    const result = await validateDeviceConfig(candidate, Boolean(req.body.mockDevice));
    res.json(result);
  })
);

app.get(
  '/api/device-info',
  asyncRoute(async (_req, res) => {
    const [deviceInfo, capabilities] = await Promise.all([
      device.deviceInfo(),
      device.capabilities()
    ]);
    res.json({ deviceInfo, capabilities });
  })
);

app.get(
  '/api/employees',
  asyncRoute(async (req, res) => {
    const maxResults = Number.parseInt(req.query.limit || '30', 10);
    const position = Number.parseInt(req.query.position || '0', 10);
    const employeeNo = req.query.employeeNo ? String(req.query.employeeNo) : undefined;
    await log('info', 'Consultando empleados en Hikvision', {
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
    await log('info', 'Enviando alta de empleado a Hikvision', {
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
    await log('info', 'Enviando modificacion de empleado a Hikvision', {
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
    await log('info', 'Enviando rostro a Hikvision', {
      employeeNo: req.params.employeeNo,
      file: req.file.originalname,
      faceRecord: {
        faceLibType: config.hikvision.faceLibType,
        FDID: config.hikvision.fdid,
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

app.get('/api/eolo/users-sync/status', (_req, res) => {
  res.json(eoloUserSync.status());
});

app.post(
  '/api/eolo/users-sync/run',
  asyncRoute(async (_req, res) => {
    const result = await eoloUserSync.runOnce();
    res.json(result);
  })
);

app.get(
  '/api/anpr/dashboard',
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/dashboard'));
  })
);

app.post(
  '/api/anpr/sync-now',
  asyncRoute(async (_req, res) => {
    res.json(await fetchAnprJson('/api/sync_now', { method: 'POST', timeoutMs: 20000 }));
  })
);

app.get('/api/events', (req, res) => {
  const limit = Number.parseInt(req.query.limit || '100', 10);
  res.json({ events: getEvents(limit) });
});

app.get('/api/logs', (req, res) => {
  const limit = Number.parseInt(req.query.limit || '100', 10);
  res.json({ logs: getLogs(limit) });
});

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
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, _next) => {
  log('error', 'Error en solicitud HTTP', {
    error: error.message,
    status: error.status,
    body: error.body
  }).catch(() => {});
  res.status(error.status || 500).json({
    ok: false,
    error: error.message,
    detail: error.body
  });
});

const server = app.listen(config.port, () => {
  log('info', `Servicio EOLO Hikvision escuchando en puerto ${config.port}`, {
    mode: config.mockDevice ? 'mock' : 'device'
  }).catch(() => {});
  taskRunner.startPolling();
  eoloUserSync.start();
});

const shutdown = () => {
  taskRunner.stopPolling();
  eoloUserSync.stop();
  if (eventStream?.running) eventStream.stop();
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
    doorNo: body.doorNo || config.hikvision.doorNo,
    planTemplateNo: body.planTemplateNo || config.hikvision.planTemplateNo
  };
}

function registerServices() {
  serviceManager.register({
    id: 'hikvision-events',
    name: 'Face Recognition Hikvision',
    group: 'bridge',
    description: 'Escucha eventos del dispositivo local o del simulador.',
    status: async () => {
      const running = config.mockDevice ? Boolean(device.interval) : Boolean(eventStream?.running);
      return {
        running,
        status: running ? 'running' : 'stopped',
        mode: config.mockDevice ? 'mock' : 'device'
      };
    },
    start: startDeviceEventService,
    stop: stopDeviceEventService
  });

  serviceManager.register({
    id: 'eolo-users-sync',
    name: 'Residentes Sync',
    group: 'bridge',
    description: 'Sincroniza permisos/residentes EOLO hacia Hikvision.',
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
  serviceManager.register(
    remoteAnprService({
      id: 'rtsp-preview',
      name: 'Visualizador Cámaras',
      baseUrl: config.anpr.baseUrl,
      description: 'Servidor interno de video para previsualizar camaras.'
    })
  );
  serviceManager.register(
    remoteAnprService({
      id: 'visit-sync',
      name: 'Visitas Sync',
      baseUrl: config.anpr.baseUrl,
      description: 'Sincroniza accesos y estacionamiento locales hacia EOLO Cloud.'
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
  return config.mockDevice ? new MockDevice() : new HikvisionClient(config.hikvision);
}

function createEventStream() {
  return config.mockDevice ? null : new DeviceEventStream(device, eoloClient);
}

function rebuildDeviceClients() {
  eoloClient.enabled = Boolean(config.eolo.baseUrl);
  device = createDevice();
  eventStream = createEventStream();
  taskRunner.device = device;
  eoloUserSync.device = device;
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
  return validateDeviceConfig(config.hikvision, config.mockDevice);
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
    const candidate = new HikvisionClient({
      ...config.hikvision,
      ...settings,
      port: Number(settings.port || config.hikvision.port)
    });
    const deviceInfo = await candidate.deviceInfo({
      signal: AbortSignal.timeout(5000)
    });
    return {
      ok: true,
      mode: 'device',
      message: 'Respuesta valida del dispositivo.',
      deviceInfo
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'device',
      message: 'No se pudo validar la respuesta del dispositivo.',
      error: error.message,
      detail: error.body
    };
  }
}
