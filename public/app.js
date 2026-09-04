const state = {
  health: null,
  deviceConfig: null,
  events: [],
  logs: [],
  services: [],
  anprDashboard: null,
  anprDashboardError: null,
  anprHardware: null,
  anprHardwareError: null,
  activeServiceTab: 'pedestrians',
  activePedestrianTab: 'devices',
  pedestrianPermissions: [],
  pedestrianPermissionSummary: null,
  pedestrianPermissionsSource: '',
  pedestrianPermissionsAccessId: '',
  pedestrianPermissionsLoading: false,
  pedestrianPermissionsLoaded: false,
  pedestrianPermissionsError: '',
  pedestrianPermissionSearch: '',
  pedestrianPermissionPage: 1,
  pedestrianPermissionPageSize: 10,
  selectedPermissionDetail: null,
  activeVehicleTab: 'devices',
  vehiclePermissions: [],
  vehiclePermissionSummary: null,
  vehiclePermissionsSource: '',
  vehiclePermissionsAccessId: '',
  vehiclePermissionsLoading: false,
  vehiclePermissionsLoaded: false,
  vehiclePermissionsError: '',
  vehiclePermissionSearch: '',
  vehiclePermissionPage: 1,
  vehiclePermissionPageSize: 10,
  selectedVehicleCameraIndex: '',
  vehicleAnprMenuOpen: false,
  vehicleCameraLastResult: null,
  selectedBarrierIndex: '',
  barrierLastResult: null,
  operatorIdentificationConfig: null,
  operatorIdentificationLoaded: false,
  operatorIdentificationLoading: false,
  operatorIdentificationError: '',
  operatorIdentificationMessage: '',
  operatorCameras: [],
  selectedOperatorCameraId: localStorage.getItem('eolo.operator.cameraId') || '',
  operatorCloudConfig: null,
  operatorCloudLoaded: false,
  operatorCloudLoading: false,
  operatorCloudError: '',
  operatorCloudMessage: '',
  operatorBridgeConfig: null,
  operatorBridgeLoaded: false,
  operatorBridgeLoading: false,
  operatorBridgeError: '',
  operatorBridgeMessage: '',
  operatorBridgeLastResult: null,
  activeSyncTab: 'cloud',
  syncPermissions: [],
  syncPermissionsSource: '',
  syncPermissionsDownloadedAt: '',
  syncPermissionsValidAfter: '',
  syncPermissionsSkippedExpired: 0,
  syncPermissionsSourceCount: 0,
  syncPermissionsLoading: false,
  syncPermissionsLoaded: false,
  syncPermissionsError: '',
  syncPermissionSearch: '',
  syncPermissionPage: 1,
  syncPermissionPageSize: 10,
  syncDeviceMessage: '',
  syncDeviceError: '',
  faceDevices: [],
  faceDeviceCloudOptionsAccessId: '',
  faceDeviceControlPoints: [],
  faceDeviceAccessDevices: [],
  faceDeviceCloudOptionsLoading: false,
  faceDeviceCloudOptionsLoaded: false,
  faceDeviceCloudOptionsError: '',
  faceDeviceCloudCreateLoading: false,
  selectedManagedFaceDeviceId: '',
  faceDeviceLastResult: null,
  activeFaceDeviceTab: 'hikvision',
  faceDeviceTabTouched: false,
  activeFaceRecognitionTab: 'operation',
  activeAnprProcessorTab: 'summary',
  deviceCommunicationOk: false,
  lastLocalCommunicationAt: null,
  latestLogId: '',
  selectedSettingsLogId: '',
  settingsLogsLoading: false,
  settingsLogsLoaded: false,
  settingsLogsError: '',
  employees: [],
  employeeDirectoryLoaded: false,
  employeePage: {
    page: 0,
    pageSize: 12,
    total: 0,
    filter: ''
  }
};

if (window.location.hash === '#face-config') {
  state.activeServiceTab = 'pedestrians';
  state.activeFaceRecognitionTab = 'config';
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const chatWindow = $('#chatWindow');
const eventList = $('#eventList');
const logList = $('#logList');

const serviceTabs = [
  { id: 'bridge-settings', label: 'Ajustes Bridge', title: 'Ajustes Bridge' },
  { id: 'pedestrians', label: 'Peatones', title: 'Peatones' },
  { id: 'vehicles', label: 'Vehiculos', title: 'Vehiculos' },
  { id: 'barriers', label: 'Puertas y Barreras', title: 'Puertas y Barreras' },
  { id: 'webrtc-preview', label: 'Visualizador RTC', title: 'Visualizador RTC' },
  { id: 'identification-reader', label: 'Lectura de Identificaciones', title: 'Lectura de Identificaciones' },
  { id: 'cloud-sync', label: 'Sincronizacion', title: 'Sincronizacion' },
  { id: 'logs', label: 'Logs', title: 'Logs' }
];

const api = async (path, options = {}) => {
  const headers = {
    ...operatorAuthHeaders(),
    ...(options.headers || {})
  };
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || response.statusText);
  }
  return payload;
};

function operatorAuthHeaders() {
  const token = localStorage.getItem('eolo.operator.token') || '';
  const userId = localStorage.getItem('eolo.operator.userId') || '';
  const expiresAt = localStorage.getItem('eolo.operator.expiresAt') || '';
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(userId ? { 'X-EOLO-User-ID': userId } : {}),
    ...(expiresAt ? { 'X-EOLO-Expires-At': expiresAt } : {})
  };
}

const pretty = (value) => JSON.stringify(value, null, 2);

function addMessage(role, content, meta) {
  const node = document.createElement('article');
  node.className = `message ${role}`;
  node.innerHTML = `
    <div class="avatar">${role === 'user' ? 'Tu' : 'AI'}</div>
    <div class="bubble">
      <p>${escapeHtml(content)}</p>
      ${meta ? `<pre>${escapeHtml(pretty(meta))}</pre>` : ''}
    </div>
  `;
  chatWindow.appendChild(node);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  addUiLog(role, content, meta);
}

function addUiLog(role, content, meta) {
  const record = {
    ts: new Date().toISOString(),
    level: meta?.ok === false || meta?.error ? 'error' : 'info',
    source: 'ui',
    message: `${role === 'user' ? 'Usuario' : 'Comandos'}: ${content}`,
    meta: meta || {}
  };
  state.logs.push(record);
  renderLogs();
  updateLatestLog(record);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const escapeAttr = escapeHtml;

function displayText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => displayText(item)).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    return (
      value.display ||
      value.name ||
      value.Nombre ||
      value.text ||
      value.label ||
      value._id ||
      value.id ||
      fallback
    );
  }
  return fallback;
}

function logDomId(record) {
  const raw = `${record.ts || ''}-${record.level || ''}-${record.message || ''}`;
  return `log-${raw.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function formatLogMessage(record) {
  if (
    record.message === 'Sincronizacion de usuarios EOLO completada' ||
    record.message === 'Sincronizacion EOLO multi-dispositivo completada'
  ) {
    return formatEoloSyncSummary(record);
  }
  if (record.message === 'Descarga de usuarios EOLO completada') {
    return formatEoloCloudSummary(record);
  }
  if (
    record.message === 'Carga de usuarios EOLO al dispositivo completada' ||
    record.message === 'Carga de snapshot EOLO a dispositivos faciales completada'
  ) {
    return formatEoloDeviceSummary(record);
  }
  const detail = record.meta?.error || record.meta?.status;
  return detail ? `${record.message}: ${detail}` : record.message;
}

function formatEoloSyncSummary(record) {
  const meta = record.meta || {};
  const deviceSummary = aggregateDeviceSyncResult(meta.device || meta);
  const created = meta.created || deviceSummary.created;
  const updated = meta.updated || deviceSummary.updated;
  const deleted = meta.deleted || deviceSummary.deleted;
  const facesUpdated = meta.facesUpdated || deviceSummary.facesUpdated;
  const skippedFaces = meta.skippedFaces || deviceSummary.skippedFaces;
  const skippedInvalid = Number(meta.skippedInvalid || 0);
  const skippedExpired = Number(meta.skippedExpired || 0);
  const parts = [
    `nube ${meta.validCloudCount ?? meta.cloudCount ?? 0}/${meta.cloudCount ?? 0}`,
    listSummary('creados', created),
    listSummary('actualizados', updated),
    listSummary('borrados', deleted),
    listSummary('rostros', facesUpdated)
  ];
  if (skippedFaces.length) parts.push(`${skippedFaces.length} rostros con error`);
  if (skippedExpired) parts.push(`${skippedExpired} permisos vencidos omitidos`);
  if (skippedInvalid) parts.push(`${skippedInvalid} registros invalidos`);
  return `${record.message}: ${parts.join(' · ')}`;
}

function formatEoloCloudSummary(record) {
  const meta = record.meta || {};
  const expired = Number(meta.skippedExpired || 0);
  return `${record.message}: snapshot ${meta.validCloudCount ?? 0}/${meta.cloudCount ?? 0}; vencidos ${expired}; invalidos ${meta.skippedInvalid ?? 0}`;
}

function formatEoloDeviceSummary(record) {
  const meta = record.meta || {};
  const summary = aggregateDeviceSyncResult(meta);
  const parts = [
    `dispositivos ${summary.successCount}/${summary.targetCount}`,
    listSummary('creados', summary.created),
    listSummary('actualizados', summary.updated),
    listSummary('borrados', summary.deleted),
    listSummary('rostros', summary.facesUpdated)
  ];
  if (summary.failedCount) parts.push(`${summary.failedCount} con error`);
  return `${record.message}: ${parts.join(' · ')}`;
}

function listSummary(label, values = []) {
  const count = values.length;
  if (!count) return `${label} 0`;
  const ids = values.slice(0, 4).join(', ');
  const extra = count > 4 ? ` +${count - 4}` : '';
  return `${label} ${count} (${ids}${extra})`;
}

function aggregateDeviceSyncResult(result = {}) {
  const source = result?.device || result || {};
  const perDevice = Array.isArray(source.results) ? source.results : [];
  const direct = perDevice.length ? {} : source;
  const collect = (field) => [
    ...asArray(direct[field]),
    ...perDevice.flatMap((item) => asArray(item?.result?.[field]))
  ];
  return {
    targetCount: Number(source.targetCount ?? perDevice.length ?? 0),
    successCount: Number(source.successCount ?? perDevice.filter((item) => item.ok).length ?? 0),
    failedCount: Number(source.failedCount ?? perDevice.filter((item) => !item.ok).length ?? 0),
    created: collect('created'),
    updated: collect('updated'),
    deleted: collect('deleted'),
    facesUpdated: collect('facesUpdated'),
    skippedFaces: collect('skippedFaces')
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function logSource(record) {
  return record.source === 'ui' ? 'ui' : record.source || record.level || 'log';
}

function setPanel(panelName) {
  parkTechnicalSettingsLayout();
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.panel === panelName);
  });
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
  $(`#${panelName}Panel`).classList.add('active');
  updateServicesNavState(panelName);
  if (panelName === 'employees' && $('#directoryTaskPanel').classList.contains('active')) {
    loadEmployees().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
  if (panelName === 'services') {
    loadServices().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
}

function currentPanelName() {
  const activePanel = document.querySelector('.panel.active');
  return activePanel?.id?.replace(/Panel$/, '') || 'employees';
}

function updateServicesNavState(panelName = currentPanelName()) {
  const group = $('#servicesNavGroup');
  const toggle = $('#servicesNavToggle');
  if (!group || !toggle) return;
  const servicesActive = panelName === 'services';
  group.classList.toggle('active', servicesActive);
  toggle.setAttribute('aria-expanded', 'true');
  renderServiceSidebar();
}

function setTaskTab(tabName) {
  document.querySelectorAll('[data-task-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.taskTab === tabName);
  });
  $('#directoryTaskPanel').classList.toggle('active', tabName === 'directory');
  $('#registerTaskPanel').classList.toggle('active', tabName === 'register');
  if (tabName === 'directory') {
    loadEmployees().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
}

function setSettingsTab(tabName) {
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.settingsTab === tabName);
  });
  $('#deviceSettingsPanel').classList.toggle('active', tabName === 'device');
  $('#eoloSettingsPanel').classList.toggle('active', tabName === 'eolo');
  $('#deviceValidationPanel').classList.toggle('active', tabName === 'device');
  $('#eoloSyncDebugPanel').classList.toggle('active', tabName === 'eolo');
  renderFaceSyncPanels();
}

function setEventsTab(tabName) {
  document.querySelectorAll('[data-events-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.eventsTab === tabName);
  });
  $('#deviceEventsPanel').classList.toggle('active', tabName === 'device');
  $('#logsEventsPanel').classList.toggle('active', tabName === 'logs');
}

function setEditTab(tabName) {
  document.querySelectorAll('[data-edit-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.editTab === tabName);
  });
  $('#editEmployeeForm').classList.toggle('active', tabName === 'details');
  $('#editEmployeeFaceForm').classList.toggle('active', tabName === 'face');
}

async function refreshHealth() {
  const [health, configPayload, info, faceDevicesPayload] = await Promise.all([
    api('/api/health'),
    api('/api/device-config'),
    api('/api/device-info').catch((error) => ({ error: error.message })),
    api('/api/face-devices').catch(() => ({ devices: [] }))
  ]);
  state.health = health;
  state.deviceConfig = configPayload;
  setManagedFaceDevices(faceDevicesPayload.devices || configPayload.faceDevices || []);
  state.deviceCommunicationOk = updateOperationalStatus(health, configPayload, info);
  updateStreamToggle(health);
  $('#deviceInfo').textContent = pretty({ health, config: configPayload, ...info });
  $('#mockEventBtn').hidden = health.mode !== 'mock';
  fillDeviceConfigForm(configPayload);
  updateBridgeBrand(configPayload);
  renderFaceSyncPanels();
}

async function refreshSyncStatus() {
  const [health, configPayload, faceDevicesPayload] = await Promise.all([
    api('/api/health'),
    api('/api/device-config'),
    api('/api/face-devices').catch(() => ({ devices: [] }))
  ]);
  state.health = health;
  state.deviceConfig = configPayload;
  setManagedFaceDevices(faceDevicesPayload.devices || configPayload.faceDevices || []);
  updateStreamToggle(health);
  fillDeviceConfigForm(configPayload);
  updateBridgeBrand(configPayload);
  renderFaceSyncPanels();
  return { health, config: configPayload };
}

function setManagedFaceDevices(devices = []) {
  state.faceDevices = Array.isArray(devices) ? devices : [];
  if (
    state.selectedManagedFaceDeviceId &&
    (state.selectedManagedFaceDeviceId === 'new' ||
      state.faceDevices.some((device) => device.id === state.selectedManagedFaceDeviceId))
  ) {
    return;
  }
  state.selectedManagedFaceDeviceId = '';
}

function updateBridgeBrand(payload = state.deviceConfig) {
  const text = $('#bridgeIdentifierText');
  if (!text) return;
  const bridgeService = serviceById('bridge-settings') || {};
  const serial =
    bridgeService.serialNumber ||
    state.operatorBridgeConfig?.serialNumber ||
    state.operatorCloudConfig?.serialNumber ||
    payload?.operator?.serialNumber ||
    state.deviceConfig?.operator?.serialNumber ||
    '';
  text.textContent = serial ? `SN ${serial}` : 'SN pendiente';
}

function faceDeviceSettings(payload = state.deviceConfig) {
  const active = state.activeFaceDeviceTab || payload?.faceDevice || 'hikvision';
  return active === 'dahua' ? payload?.dahua || {} : payload?.hikvision || {};
}

function updateOperationalStatus(health, configPayload, info = {}) {
  const device = faceDeviceSettings(configPayload);
  const usingMock = health.mode === 'mock';
  const communicating = usingMock || !info.error;
  const streamLabel = health.stream?.running ? 'eventos activos' : 'eventos detenidos';
  const target = `${device.protocol || health.deviceProtocol}://${device.host || health.deviceHost}:${device.port || health.devicePort}`;

  let title = 'Sin comunicacion';
  let detail = info.error || 'No se pudo confirmar respuesta del dispositivo.';

  if (usingMock) {
    title = 'Modo prueba activo';
    detail = `Simulador local en uso; ${streamLabel}.`;
  } else if (communicating) {
    const deviceInfo = info.deviceInfo?.DeviceInfo || info.deviceInfo || {};
    const model = deviceInfo.model || deviceInfo.deviceName || deviceInfo.serialNumber || target;
    title = 'Conectado y comunicando';
    detail = `${model}; ${streamLabel}.`;
  }

  if (communicating) {
    state.lastLocalCommunicationAt = new Date().toISOString();
  }
  updateSidebarCommunicationStatus(communicating, health.eoloUserSync?.lastRunAt);
  $('#statusDot').classList.toggle('online', communicating);

  setSummaryCard('#deviceConnectionCard', communicating ? 'ok' : 'fail');
  $('#deviceConnectionTitle').textContent = title;
  $('#deviceConnectionDetail').textContent = detail;

  const passwordSet = Boolean(device.passwordSet);
  setSummaryCard('#passwordStatusCard', passwordSet ? 'ok' : 'warn');
  $('#passwordStatusTitle').textContent = passwordSet
    ? 'Contrasena guardada'
    : 'Sin contrasena guardada';
  $('#passwordStatusDetail').textContent = passwordSet
    ? 'Se conservara hasta que actives el cambio de contrasena.'
    : 'Debes capturar una contrasena antes de guardar o probar contra el dispositivo.';

  const syncStatus = health.eoloUserSync || {};
  const operatorTokenSet = Boolean(localStorage.getItem('eolo.operator.token'));
  const syncReady = Boolean(
    syncStatus.enabled && syncStatus.accessSet && (syncStatus.effectiveTokenSet || syncStatus.tokenSet || operatorTokenSet)
  );
  const syncMissing = [
    !syncStatus.enabled ? 'opcion desactivada' : '',
    !syncStatus.accessSet ? 'acceso faltante' : '',
    !syncStatus.effectiveTokenSet && !syncStatus.tokenSet && !operatorTokenSet ? 'token faltante' : ''
  ].filter(Boolean);
  setSummaryCard('#eoloSyncStatusCard', syncReady ? 'ok' : syncStatus.enabled ? 'warn' : 'fail');
  $('#eoloSyncStatusTitle').textContent = syncReady
    ? 'Sincronizacion EOLO activa'
    : 'Sincronizacion EOLO pendiente';
  $('#eoloSyncStatusDetail').textContent = syncReady
    ? `Cada ${syncStatus.intervalMinutes || '-'} min.; ultimo: ${syncStatus.lastRunAt || 'sin ejecucion'}.`
    : syncMissing.join(', ') || 'Configura EOLO para descargar usuarios.';

  return communicating;
}

function updateSidebarCommunicationStatus(localOnline, cloudLastRunAt) {
  $('#statusMode').textContent = 'Última Comunicación';
  $('#localCommunicationTime').textContent = formatCommunicationTime(
    state.lastLocalCommunicationAt
  );
  $('#cloudCommunicationTime').textContent = formatCommunicationTime(cloudLastRunAt);
  $('#statusDetail').classList.toggle('local-online', Boolean(localOnline));
  $('#statusDetail').classList.toggle('cloud-online', Boolean(cloudLastRunAt));
}

function formatCommunicationTime(value) {
  if (!value) return 'ND';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'ND';
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = String(hours % 12 || 12).padStart(2, '0');
  return `${hour12}:${minutes} ${suffix}`;
}

function setSummaryCard(selector, status) {
  const card = $(selector);
  if (!card) return;
  card.classList.remove('ok', 'warn', 'fail');
  card.classList.add(status);
}

async function toggleStream() {
  const running = state.health?.stream?.running;
  if (!running && !state.deviceCommunicationOk) {
    addMessage('assistant', 'Valida primero la comunicacion con el dispositivo local.', {
      ok: false,
      error: true
    });
    return;
  }
  const result = await api(running ? '/api/device/stream/stop' : '/api/device/stream/start', {
    method: 'POST'
  });
  addMessage('assistant', running ? 'Lectura de eventos detenida.' : 'Lectura de eventos iniciada.', result);
  await refreshHealth();
}

function updateStreamToggle(health = state.health) {
  const button = $('#streamBtn');
  const status = $('#streamToggleStatus');
  if (!button || !status) return;
  const running = Boolean(health?.stream?.running);
  const available = running || state.deviceCommunicationOk;
  button.disabled = !available;
  button.classList.toggle('is-on', running);
  button.classList.toggle('is-disabled', !available);
  button.setAttribute('aria-checked', String(running));
  button.title = available
    ? running
      ? 'Detener escucha de eventos del dispositivo'
      : 'Iniciar escucha de eventos del dispositivo'
    : 'Valida la comunicacion con el dispositivo local para escuchar eventos';
  status.textContent = running ? 'Activo' : available ? 'Inactivo' : 'Validacion requerida';
}

async function loadServices() {
  const [payload, anprDashboard, anprHardware, faceDevicesPayload] = await Promise.all([
    api('/api/services'),
    api('/api/anpr/dashboard').catch((error) => ({ ok: false, error: error.message })),
    api('/api/anpr/hardware').catch((error) => ({ ok: false, error: error.message })),
    api('/api/face-devices').catch(() => ({ devices: [] }))
  ]);
  state.services = payload.services || [];
  setManagedFaceDevices(faceDevicesPayload.devices || []);
  state.anprDashboardError = anprDashboard.ok === false ? anprDashboard.error : null;
  state.anprDashboard = anprDashboard.ok === false ? null : anprDashboard;
  state.anprHardwareError = anprHardware.ok === false ? anprHardware.error : null;
  state.anprHardware = anprHardware.ok === false ? state.anprHardware : anprHardware;
  ensureActiveServiceTab();
  updateBridgeBrand();
  renderServices();
  return payload;
}

async function controlService(serviceId, action) {
  const payload = await api(`/api/services/${encodeURIComponent(serviceId)}/${action}`, {
    method: 'POST'
  });
  state.services = payload.services || [];
  if (state.activeServiceTab === serviceId || serviceId.startsWith('anpr') || serviceId === 'barriers' || serviceId === 'visit-sync' || serviceId === 'webrtc-preview') {
    const dashboardPayload = await api('/api/anpr/dashboard').catch((error) => {
      state.anprDashboardError = error.message;
      return state.anprDashboard;
    });
    if (dashboardPayload?.ok !== false) {
      state.anprDashboard = dashboardPayload;
      state.anprDashboardError = null;
    }
  }
  renderServices();
  addMessage('assistant', `Servicio ${serviceId}: ${action}.`, payload.service || payload);
}

function renderServices() {
  const grid = $('#serviceGrid');
  if (!grid) return;
  const customServiceView = [
    'bridge-settings',
    'pedestrians',
    'vehicles',
    'barriers',
    'webrtc-preview',
    'identification-reader',
    'cloud-sync',
    'logs'
  ].includes(state.activeServiceTab);
  grid.hidden = customServiceView;
  if (grid.hidden) {
    grid.innerHTML = '';
    renderServiceSidebar();
    renderServiceTabs();
    renderServiceDetail();
    return;
  }
  if (!state.services.length) {
    grid.innerHTML = '<div class="empty-state">Sin servicios reportados.</div>';
    renderServiceSidebar();
    renderServiceTabs();
    renderServiceDetail();
    return;
  }

  const activeService = serviceById(state.activeServiceTab);
  const visibleServices = activeService.id ? [activeService] : state.services;

  grid.innerHTML = visibleServices
    .map((service) => {
      const running = Boolean(service.running);
      const status = service.status || (running ? 'running' : 'stopped');
      const disabled = service.controllable === false;
      const detail = service.error || service.description || service.group || '';
      return `
        <article class="service-row ${running ? 'running' : 'stopped'}">
          <div class="service-main">
            <span class="service-dot" aria-hidden="true"></span>
            <div>
              <strong>${escapeHtml(service.name || service.id)}</strong>
              <span>${escapeHtml(service.group || 'local')} · ${escapeHtml(status)}</span>
              ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
            </div>
          </div>
          <div class="service-actions">
            <button type="button" data-service-action="start" data-service-id="${escapeHtml(service.id)}" ${disabled || running ? 'disabled' : ''}>Iniciar</button>
            <button type="button" data-service-action="stop" data-service-id="${escapeHtml(service.id)}" ${disabled || !running ? 'disabled' : ''}>Detener</button>
            <button type="button" data-service-action="restart" data-service-id="${escapeHtml(service.id)}" ${disabled ? 'disabled' : ''}>Reiniciar</button>
          </div>
        </article>
      `;
    })
    .join('');
  renderServiceSidebar();
  renderServiceTabs();
  renderServiceDetail();
}

function ensureActiveServiceTab() {
  if (serviceTabs.some((tab) => tab.id === state.activeServiceTab)) return;
  state.activeServiceTab = serviceTabs[0].id;
}

function serviceById(serviceId) {
  return state.services.find((service) => service.id === serviceId) || {};
}

function serviceIsRunning(serviceId) {
  return Boolean(serviceById(serviceId).running);
}

function renderServiceSidebar() {
  const menu = $('#serviceSidebarMenu');
  if (!menu) return;
  const servicesPanelActive = currentPanelName() === 'services';
  menu.innerHTML = serviceTabs
    .map((tab) => {
      const service = serviceById(tab.id);
      const running = Boolean(service.running);
      const active = servicesPanelActive && state.activeServiceTab === tab.id;
      return `
        <button class="nav-subitem ${active ? 'active' : ''}" type="button" role="menuitem"
          data-service-sidebar="${escapeHtml(tab.id)}">
          <span class="mini-status ${running ? 'running' : 'stopped'}" aria-hidden="true"></span>
          <span>${escapeHtml(tab.label)}</span>
        </button>
      `;
    })
    .join('');
}

function renderServiceTabs() {
  const tabs = $('#serviceTabs');
  if (!tabs) return;
  tabs.innerHTML = serviceTabs
    .map((tab) => {
      const service = serviceById(tab.id);
      const running = Boolean(service.running);
      const active = state.activeServiceTab === tab.id;
      return `
        <button class="service-tab-button ${active ? 'active' : ''}" type="button" role="tab"
          aria-selected="${active}" data-service-tab="${escapeHtml(tab.id)}">
          <span class="mini-status ${running ? 'running' : 'stopped'}" aria-hidden="true"></span>
          <span>${escapeHtml(tab.label)}</span>
        </button>
      `;
    })
    .join('');
}

function renderServiceDetail() {
  const detail = $('#serviceDetail');
  if (!detail) return;
  parkEmployeeWorkspace();
  parkTechnicalSettingsLayout();
  const tab = serviceTabs.find((item) => item.id === state.activeServiceTab) || serviceTabs[0];
  const service = serviceById(tab.id);
  const renderers = {
    'bridge-settings': renderBridgeSettingsServiceView,
    pedestrians: renderPedestriansServiceView,
    vehicles: renderVehiclesServiceView,
    'hikvision-events': renderHikvisionServiceView,
    'face-devices': renderFaceDevicesServiceView,
    'eolo-users-sync': renderEoloUsersServiceView,
    'eolo-task-poller': renderEoloTasksServiceView,
    'anpr-api': renderAnprApiServiceView,
    'anpr-processor': renderAnprProcessorServiceView,
    barriers: renderBarriersServiceView,
    'rtsp-preview': renderRtspPreviewServiceView,
    'webrtc-preview': renderWebrtcPreviewServiceView,
    'identification-reader': renderIdentificationReaderServiceView,
    'cloud-sync': renderCloudSyncServiceView,
    logs: renderLogsServiceView,
    'visit-sync': renderVisitSyncServiceView
  };
  const body = (renderers[tab.id] || renderEmptyServiceView)(service);
  const customHeader = [
    'bridge-settings',
    'pedestrians',
    'vehicles',
    'barriers',
    'webrtc-preview',
    'identification-reader',
    'cloud-sync',
    'logs'
  ].includes(tab.id);
  detail.innerHTML = customHeader
    ? body
    : `
      <div class="service-detail-header">
        <div>
          <h3>${escapeHtml(tab.title)}</h3>
          <p>${escapeHtml(service.description || 'Vista operativa del servicio seleccionado.')}</p>
        </div>
        ${renderServiceStatusPill(service)}
      </div>
      ${body}
    `;
  mountEmployeeWorkspace();
  mountTechnicalSettingsLayout();
  updateManagedFaceDeviceTypeSections();
  syncManagedFaceDeviceControlPointName();
  updateStreamToggle();
  syncIdentificationReaderControls();
  syncCloudSyncControls();
  syncSyncDeviceControls();
  maybeLoadPedestrianPermissions();
  maybeLoadVehiclePermissions();
  maybeLoadIdentificationReaderSettings();
  maybeLoadCloudSyncSettings();
  maybeLoadBridgeSettings();
  maybeLoadSyncPermissions();
  maybeLoadSettingsLogs();
  maybeLoadManagedFaceDeviceCloudOptions();
  renderPermissionDetailModal();
}

function parkEmployeeWorkspace() {
  const workspace = $('#employeeWorkspace');
  const panel = $('#employeesPanel');
  if (!workspace || !panel || workspace.parentElement === panel) return;
  panel.appendChild(workspace);
}

function mountEmployeeWorkspace() {
  const mount = $('#faceEmployeesMount');
  const workspace = $('#employeeWorkspace');
  if (!mount || !workspace) return;
  mount.appendChild(workspace);
  if ($('#directoryTaskPanel')?.classList.contains('active') && !state.employeeDirectoryLoaded) {
    loadEmployees(state.employeePage.filter, state.employeePage.page).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
  }
}

function parkTechnicalSettingsLayout() {
  const layout = $('#technicalSettingsLayout');
  const panel = $('#settingsPanel');
  if (!layout || !panel || layout.parentElement === panel) return;
  panel.appendChild(layout);
}

function mountTechnicalSettingsLayout() {
  const mount = $('#faceConfigMount');
  const layout = $('#technicalSettingsLayout');
  if (!mount || !layout) return;
  mount.appendChild(layout);
  syncFaceDeviceControls();
  renderFaceSyncPanels();
}

function renderServiceStatusPill(service = {}) {
  const running = Boolean(service.running);
  const status = service.status || (running ? 'running' : 'stopped');
  return `<span class="status-pill ${running ? 'ok' : 'idle'}">${escapeHtml(status)}</span>`;
}

function renderMetrics(items) {
  return `
    <div class="metric-strip">
      ${items
        .map(
          (item) => `
            <div class="metric-item">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(item.value ?? '-')}</strong>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderDefinitionList(items) {
  return `
    <dl class="service-def-list">
      ${items
        .map(
          (item) => `
            <div>
              <dt>${escapeHtml(item.label)}</dt>
              <dd>${escapeHtml(item.value ?? '-')}</dd>
            </div>
          `
        )
        .join('')}
    </dl>
  `;
}

function renderTable(headers, rows, emptyText = 'Sin registros para mostrar.') {
  if (!rows.length) {
    return `<div class="empty-state compact">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="service-table-wrap">
      <table class="service-table">
        <thead>
          <tr>${headers.map((header) => `<th>${escapeHtml(header.label)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  ${headers
                    .map((header) => `<td>${escapeHtml(resolveCell(row, header))}</td>`)
                    .join('')}
                </tr>
              `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function resolveCell(row, header) {
  const value = typeof header.value === 'function' ? header.value(row) : row[header.value];
  if (header.type === 'sync') return Number(value) === 1 ? 'Sincronizado' : 'Pendiente';
  if (header.type === 'bool') return value ? 'Si' : 'No';
  if (header.type === 'money') return value === null || value === undefined ? '-' : `$${Number(value).toFixed(2)}`;
  return value === null || value === undefined || value === '' ? '-' : value;
}

function dashboard() {
  return state.anprDashboard || {};
}

function anprConfig() {
  return dashboard().config || {};
}

function anprServices() {
  return dashboard().services || {};
}

function anprService(serviceId) {
  return anprServices()[serviceId] || {};
}

function anprHardware() {
  return state.anprHardware || { cameras: [], barriers: [] };
}

function vehicleCameras() {
  const hardware = anprHardware();
  const hardwareCameras = Array.isArray(hardware.cameras) ? hardware.cameras : [];
  if (hardwareCameras.length) return hardwareCameras;
  const configCameras = anprConfig().cameras || [];
  return configCameras.map((camera) => ({
    ...camera,
    rtsp: camera.rtsp || camera.rtsp_url || ''
  }));
}

function cameraHasRtsp(camera = {}) {
  return Boolean(camera.rtsp || camera.rtsp_url || camera.has_rtsp);
}

function cameraBarrierIds(camera = {}) {
  return Array.isArray(camera.barrier_ids) ? camera.barrier_ids.filter(Boolean) : [];
}

function cameraHasBarrier(camera = {}, barriers = anprHardware().barriers || []) {
  const ids = cameraBarrierIds(camera);
  if (ids.length) return true;
  if (camera.barrier_count || camera.has_barrier) return true;
  return barriers.some((barrier) => {
    if (!barrier) return false;
    return barrier.camera_name && camera.name && barrier.camera_name === camera.name;
  });
}

function barrierDevices() {
  const hardwareBarriers = anprHardware().barriers || [];
  if (hardwareBarriers.length) return hardwareBarriers;
  return anprConfig().barriers || [];
}

function barrierTypeLabel(type = 'hikvision-isapi') {
  return type === 'hikvision-isapi' || !type ? 'Hikvision ISAPI' : type;
}

function barrierId(barrier = {}) {
  return barrier.id_barra || barrier.id || barrier.numero_barra || '';
}

function associatedBarrierIds() {
  const ids = new Set();
  vehicleCameras().forEach((camera) => {
    cameraBarrierIds(camera).forEach((id) => ids.add(id));
  });
  return ids;
}

function barrierIsAssociated(barrier = {}) {
  const id = barrierId(barrier);
  if (id && associatedBarrierIds().has(id)) return true;
  return Boolean(barrier.camera_name && vehicleCameras().some((camera) => camera.name === barrier.camera_name));
}

function associatedBarrierCount() {
  return barrierDevices().filter(barrierIsAssociated).length;
}

function activeVehicleRtspCount() {
  const running = serviceIsRunning('anpr-processor') || Boolean(anprService('anpr-processor').running);
  if (!running) return 0;
  return vehicleCameras().filter(cameraHasRtsp).length;
}

function anprApiIsRunning() {
  return serviceIsRunning('anpr-api') || Boolean(dashboard().ok && !state.anprDashboardError);
}

function renderAnprUnavailable() {
  if (!state.anprDashboardError) return '';
  return `<div class="service-warning">ANPR no responde: ${escapeHtml(state.anprDashboardError)}</div>`;
}

function renderServiceActions(serviceId, options = {}) {
  const service = serviceById(serviceId);
  const running = Boolean(service.running);
  const disabled = service.controllable === false;
  return `
    <div class="inline-actions">
      <button type="button" data-service-action="start" data-service-id="${escapeHtml(serviceId)}" ${disabled || running ? 'disabled' : ''}>Iniciar</button>
      <button type="button" data-service-action="stop" data-service-id="${escapeHtml(serviceId)}" ${disabled || !running ? 'disabled' : ''}>Detener</button>
      <button type="button" data-service-action="restart" data-service-id="${escapeHtml(serviceId)}" ${disabled ? 'disabled' : ''}>Reiniciar</button>
      ${options.extra || ''}
    </div>
  `;
}

function renderPedestriansServiceView() {
  const devices = state.faceDevices || [];
  const permissions = state.pedestrianPermissions || [];
  const summary = state.pedestrianPermissionSummary || summarizePedestrianPermissions(permissions);
  const activeDevices = devices.filter((device) => device.stream?.running).length;
  const streamText = `${activeDevices} ${activeDevices === 1 ? 'Stream' : 'Streams'}`;
  return `
    <section class="pedestrians-hero-card">
      <div>
        <h3>Peatones</h3>
        <p>Administra los servicios y dispositivos locales para reconocer, registrar y administrar peatones.</p>
      </div>
      <span class="stream-led-pill ${activeDevices ? 'active' : ''}">
        <i aria-hidden="true"></i>
        ${escapeHtml(streamText)}
      </span>
    </section>
    ${renderMetrics([
      { label: 'Dispositivos', value: devices.length },
      { label: 'Activos', value: activeDevices },
      { label: 'Peatones', value: summary.pedestrians || 0 },
      { label: 'Rostros', value: summary.faces || 0 },
      { label: 'Tarjetas', value: summary.cards || 0 },
      { label: 'Codigos', value: summary.codes || 0 }
    ])}
    <div class="service-inner-tabs pedestrians-tabs" role="tablist" aria-label="Peatones">
      <button class="service-inner-tab ${state.activePedestrianTab === 'devices' ? 'active' : ''}" type="button" data-pedestrian-tab="devices">Dispositivos</button>
      <button class="service-inner-tab ${state.activePedestrianTab === 'permissions' ? 'active' : ''}" type="button" data-pedestrian-tab="permissions">Permisos</button>
    </div>
    ${state.activePedestrianTab === 'permissions' ? renderPedestrianPermissionsView() : renderPedestrianDevicesView()}
  `;
}

function renderPedestrianDevicesView() {
  const devices = state.faceDevices || [];
  const selected = state.selectedManagedFaceDeviceId ? selectedManagedFaceDevice() : null;
  return `
    ${selected ? `
      <section class="service-section wide pedestrians-section">
        <div class="service-section-heading compact device-editor-heading">
          <button type="button" class="icon-button chevron-back-button" data-face-device-back aria-label="Regresar a dispositivos">
            <span aria-hidden="true">‹</span>
          </button>
          <div class="device-editor-title">
            <h4>${selected.id === 'new' ? 'Nuevo dispositivo' : `Editar ${escapeHtml(selected.name || 'dispositivo')}`}</h4>
            <p>${selected.id === 'new' ? 'Captura los parametros de conexion local.' : `${deviceTypeLabel(selected.type)} en ${selected.host || '-'}`}</p>
          </div>
          <span class="status-pill ${selected.enabled && selected.lastTestOk ? 'ok' : 'idle'}">${selected.enabled && selected.lastTestOk ? 'probado' : 'pendiente prueba'}</span>
        </div>
        ${renderManagedFaceDeviceEditor(selected, { compact: true })}
      </section>
    ` : `
      <section class="service-section wide pedestrians-section">
        <div class="service-section-heading compact">
          <div>
            <h4>Dispositivos registrados</h4>
            <p>Terminales locales Hikvision Mini Moe o Dahua ASI disponibles para escucha y carga de permisos.</p>
          </div>
          <button type="button" class="primary-button" data-face-device-new>Nuevo Dispositivo</button>
        </div>
        ${renderFaceDevicesTable(devices)}
      </section>
    `}
  `;
}

function renderFaceDevicesTable(devices = []) {
  if (!devices.length) return '<div class="empty-state compact">Sin dispositivos registrados localmente.</div>';
  return `
    <div class="service-table-wrap">
      <table class="service-table pedestrians-table">
        <thead>
          <tr>
            <th>Nombre local</th>
            <th>IP</th>
            <th>Tipo</th>
            <th>Comunicacion</th>
            <th>Escucha</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${devices.map((device) => `
            <tr>
              <td><strong>${escapeHtml(device.name || device.bridgeIdentifier || 'Dispositivo')}</strong></td>
              <td>${escapeHtml(device.host || '-')}:${escapeHtml(device.port || '-')}</td>
              <td>${escapeHtml(deviceTypeLabel(device.type))}</td>
              <td>${renderStateLed(device.lastTestOk, device.lastTestOk ? 'Probada' : 'Pendiente')}</td>
              <td>${renderStateLed(device.stream?.running, device.stream?.running ? 'Activa' : 'Detenida')}</td>
              <td><button type="button" data-face-device-select="${escapeAttr(device.id)}">Editar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderPedestrianPermissionsView() {
  const access = pedestrianAccessContext();
  const permissions = filterPermissionsForTable(state.pedestrianPermissions || [], 'pedestrian');
  const page = paginatePermissions(permissions, 'pedestrian');
  return `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Permisos</h4>
          <p>${access.id ? `Acceso activo: ${escapeHtml(access.name || access.id)}` : 'Selecciona un acceso en Operador para filtrar permisos.'}</p>
        </div>
        <div class="inline-actions compact-actions">
          <button type="button" data-pedestrian-permissions-refresh ${state.pedestrianPermissionsLoading || !access.id ? 'disabled' : ''}>
            ${state.pedestrianPermissionsLoading ? 'Actualizando...' : 'Actualizar permisos'}
          </button>
        </div>
      </div>
      ${state.pedestrianPermissionsError ? `<div class="service-warning">${escapeHtml(state.pedestrianPermissionsError)}</div>` : ''}
      ${renderPermissionTableToolbar('pedestrian', permissions.length)}
      ${renderPedestrianPermissionsTable(page.items)}
      ${renderPermissionPagination('pedestrian', page)}
    </section>
  `;
}

function renderPedestrianPermissionsTable(permissions = []) {
  if (!permissions.length) return '<div class="empty-state compact">Sin PermisoAccesos descargados para el acceso activo.</div>';
  return `
    <div class="service-table-wrap">
      <table class="service-table pedestrians-table">
        <thead>
          <tr>
            <th>NombrePrincipal</th>
            <th>ID2</th>
            <th>TipoEntidad</th>
            <th>Tipo Permiso</th>
            <th>Codigo QR</th>
            <th>Tarjeta</th>
            <th>Rostro</th>
            <th>AperturaAutomatica</th>
            <th>Detalle</th>
          </tr>
        </thead>
        <tbody>
          ${permissions.map((permission) => `
            <tr>
              <td>
                <strong>${escapeHtml(permission.principal_name || permission.user_name || '-')}</strong>
                <small>${escapeHtml(permission.local_id || permission.id || '')}</small>
              </td>
              <td><code>${escapeHtml(permission.id2_text || permission.id2 || '-')}</code></td>
              <td>${escapeHtml(permission.entity_type || permission.permission_type || 'Persona')}</td>
              <td>${escapeHtml(permissionTypeLabel(permission))}</td>
              <td>${renderInlineCheck(permission.has_qr)}</td>
              <td>${renderInlineCheck(permission.has_card)}</td>
              <td>${renderInlineCheck(permissionHasFace(permission))}</td>
              <td>${renderInlineCheck(permission.has_automatic_opening)}</td>
              <td>${renderPermissionDetailButton('pedestrian', permission)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderVehiclesServiceView() {
  const cameras = vehicleCameras();
  const permissions = state.vehiclePermissions || [];
  const summary = state.vehiclePermissionSummary || summarizeVehiclePermissions(permissions);
  const rtspStreams = activeVehicleRtspCount();
  const apiRunning = anprApiIsRunning();
  return `
    <section class="pedestrians-hero-card vehicles-hero-card">
      <div>
        <h3>Vehiculo</h3>
        <p>Administra los servicios y dispositivos locales para reconocer, registrar y administrar vehiculos.</p>
      </div>
      <div class="vehicle-hero-actions">
        <span class="stream-led-pill ${apiRunning ? 'active' : ''}">
          <i aria-hidden="true"></i>
          ${apiRunning ? 'API ANPR ON' : 'API ANPR OFF'}
        </span>
        <span class="stream-led-pill ${rtspStreams ? 'active' : ''}">
          <i aria-hidden="true"></i>
          ${escapeHtml(`${rtspStreams} ${rtspStreams === 1 ? 'RTSP' : 'RTSP'}`)}
        </span>
        <button type="button" data-vehicle-refresh>Actualizar</button>
        <div class="vehicle-action-menu-wrap">
          <button type="button" class="icon-button vehicle-menu-button" data-vehicle-anpr-menu-toggle aria-label="Controles ANPR">
            <span aria-hidden="true">⋮</span>
          </button>
          <div class="vehicle-action-menu ${state.vehicleAnprMenuOpen ? 'open' : ''}">
            ${renderVehicleServiceAction('start', 'Iniciar')}
            ${renderVehicleServiceAction('stop', 'Detener')}
            ${renderVehicleServiceAction('restart', 'Reiniciar')}
          </div>
        </div>
      </div>
    </section>
    ${renderMetrics([
      { label: 'Dispositivos', value: cameras.length },
      { label: 'Activos', value: rtspStreams },
      { label: 'Vehiculos', value: summary.vehicles || 0 },
      { label: 'Placas', value: summary.plates || 0 },
      { label: 'Tarjetas', value: summary.cards || 0 },
      { label: 'Codigos', value: summary.codes || 0 }
    ])}
    <div class="service-inner-tabs pedestrians-tabs vehicles-tabs" role="tablist" aria-label="Vehiculos">
      <button class="service-inner-tab ${state.activeVehicleTab === 'devices' ? 'active' : ''}" type="button" data-vehicle-tab="devices">Dispositivos</button>
      <button class="service-inner-tab ${state.activeVehicleTab === 'processor' ? 'active' : ''}" type="button" data-vehicle-tab="processor">Procesador ANPR</button>
      <button class="service-inner-tab ${state.activeVehicleTab === 'permissions' ? 'active' : ''}" type="button" data-vehicle-tab="permissions">Permisos</button>
    </div>
    ${renderVehicleActiveTab()}
  `;
}

function renderVehicleActiveTab() {
  if (state.activeVehicleTab === 'permissions') return renderVehiclePermissionsView();
  if (state.activeVehicleTab === 'processor') return renderVehicleAnprProcessorView();
  return renderVehicleDevicesView();
}

function renderVehicleServiceAction(action, label) {
  const service = serviceById('anpr-processor');
  const running = Boolean(service.running);
  const disabled =
    service.controllable === false ||
    (action === 'start' && running) ||
    (action === 'stop' && !running);
  return `
    <button type="button" data-service-action="${escapeAttr(action)}" data-service-id="anpr-processor" ${disabled ? 'disabled' : ''}>
      ${escapeHtml(label)}
    </button>
  `;
}

function renderVehicleDevicesView() {
  const selected = selectedVehicleCamera();
  return `
    ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
    ${selected ? `
      <section class="service-section wide pedestrians-section">
        <div class="service-section-heading compact device-editor-heading">
          <button type="button" class="icon-button chevron-back-button" data-vehicle-camera-back aria-label="Regresar a camaras">
            <span aria-hidden="true">‹</span>
          </button>
          <div class="device-editor-title">
            <h4>${state.selectedVehicleCameraIndex === 'new' ? 'Nueva camara' : `Editar ${escapeHtml(selected.name || 'camara')}`}</h4>
            <p>${state.selectedVehicleCameraIndex === 'new' ? 'Configura el stream RTSP y sus barreras asociadas.' : `${selected.type || 'Camara'} · ${maskRtspForUi(selected.rtsp || selected.rtsp_url || '-')}`}</p>
          </div>
          ${renderStateLed(cameraHasBarrier(selected), cameraHasBarrier(selected) ? 'Con barrera' : 'Sin barrera')}
        </div>
        ${renderVehicleCameraEditor(selected)}
      </section>
    ` : `
      <section class="service-section wide pedestrians-section">
        <div class="service-section-heading compact">
          <div>
            <h4>Camaras registradas</h4>
            <p>Camaras locales RTSP disponibles para deteccion de placas y apertura automatica por barrera.</p>
          </div>
          <button type="button" class="primary-button" data-vehicle-camera-new>Nueva Camara</button>
        </div>
        ${renderVehicleCamerasTable(vehicleCameras())}
      </section>
    `}
  `;
}

function renderVehicleCamerasTable(cameras = []) {
  if (!cameras.length) return '<div class="empty-state compact">Sin camaras registradas localmente.</div>';
  const barriers = anprHardware().barriers || [];
  const processorRunning = serviceIsRunning('anpr-processor') || Boolean(anprService('anpr-processor').running);
  return `
    <div class="service-table-wrap">
      <table class="service-table pedestrians-table">
        <thead>
          <tr>
            <th>Nombre local</th>
            <th>RTSP / IP</th>
            <th>Tipo</th>
            <th>Prefijo</th>
            <th>Barrera</th>
            <th>Lectura</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${cameras.map((camera, index) => `
            <tr>
              <td><strong>${escapeHtml(camera.name || `Camara ${index + 1}`)}</strong></td>
              <td>${escapeHtml(maskRtspForUi(camera.rtsp || camera.rtsp_url || '-'))}</td>
              <td>${escapeHtml(camera.type || '-')}</td>
              <td>${escapeHtml(camera.prefix || '-')}</td>
              <td>${renderStateLed(cameraHasBarrier(camera, barriers), cameraHasBarrier(camera, barriers) ? 'Asociada' : 'Sin barrera')}</td>
              <td>${renderStateLed(processorRunning && cameraHasRtsp(camera), processorRunning && cameraHasRtsp(camera) ? 'Activa' : 'Detenida')}</td>
              <td><button type="button" data-vehicle-camera-edit="${index}">Editar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderVehicleCameraEditor(camera = emptyCamera()) {
  const barriers = anprHardware().barriers || [];
  const linkedIds = new Set(cameraBarrierIds(camera));
  return `
    <form class="hardware-form vehicle-camera-form" id="vehicleCameraForm">
      <div class="hardware-editor-block">
        <div class="hardware-row camera-row" data-camera-row>
          <label>
            Nombre / ubicacion
            <input name="camera_name" value="${escapeAttr(camera.name || '')}" placeholder="Entrada Principal" />
          </label>
          <label class="wide-field">
            RTSP URL
            <input name="camera_rtsp" value="${escapeAttr(camera.rtsp || camera.rtsp_url || '')}" placeholder="rtsp://usuario:pass@ip:puerto/path" />
          </label>
          <label>
            Tipo
            <select name="camera_type">
              <option value="Entrada" ${camera.type === 'Entrada' ? 'selected' : ''}>Entrada</option>
              <option value="Salida" ${camera.type === 'Salida' ? 'selected' : ''}>Salida</option>
            </select>
          </label>
          <label>
            Prefijo
            <input name="camera_prefix" value="${escapeAttr(camera.prefix || '')}" maxlength="3" placeholder="ENT" />
          </label>
          <div class="wide-field barrier-picker">
            <span>Barreras asociadas</span>
            <div class="barrier-checkboxes">
              ${barriers.length
                ? barriers
                    .map((barrier) => {
                      const id = barrier.id_barra || '';
                      const label = barrier.numero_barra ? `${barrier.numero_barra} - ${id}` : id;
                      return `
                        <label class="barrier-checkbox">
                          <input type="checkbox" data-vehicle-camera-barrier-id="${escapeAttr(id)}" ${linkedIds.has(id) ? 'checked' : ''} />
                          <span>${escapeHtml(label || 'Sin ID')}</span>
                        </label>
                      `;
                    })
                    .join('')
                : '<span class="muted-inline">Registra barreras para vincularlas.</span>'}
            </div>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" data-vehicle-camera-back>Cancelar</button>
        <button type="submit" class="primary-button">Guardar</button>
      </div>
      ${state.vehicleCameraLastResult ? `<pre class="face-device-result">${escapeHtml(pretty(state.vehicleCameraLastResult))}</pre>` : ''}
    </form>
  `;
}

function renderVehiclePermissionsView() {
  const access = pedestrianAccessContext();
  const permissions = filterPermissionsForTable(state.vehiclePermissions || [], 'vehicle');
  const page = paginatePermissions(permissions, 'vehicle');
  return `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Permisos</h4>
          <p>${access.id ? `Acceso activo: ${escapeHtml(access.name || access.id)}` : 'Selecciona un acceso en Operador para filtrar permisos.'}</p>
        </div>
        <div class="inline-actions compact-actions">
          <button type="button" data-vehicle-permissions-refresh ${state.vehiclePermissionsLoading || !access.id ? 'disabled' : ''}>
            ${state.vehiclePermissionsLoading ? 'Actualizando...' : 'Actualizar permisos'}
          </button>
        </div>
      </div>
      ${state.vehiclePermissionsError ? `<div class="service-warning">${escapeHtml(state.vehiclePermissionsError)}</div>` : ''}
      ${renderPermissionTableToolbar('vehicle', permissions.length)}
      ${renderVehiclePermissionsTable(page.items)}
      ${renderPermissionPagination('vehicle', page)}
    </section>
  `;
}

function renderVehicleAnprProcessorView() {
  const cfg = anprConfig();
  const localStatus = serviceById('anpr-processor');
  const dashboardStatus = anprService('anpr-processor');
  const status = { ...dashboardStatus, ...localStatus };
  const cameras = vehicleCameras();
  const rtspCameras = cameras.filter(cameraHasRtsp).length;
  const activeStreams = activeVehicleRtspCount();
  const apiRunning = anprApiIsRunning();
  return `
    ${renderAnprUnavailable()}
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Estatus del procesador</h4>
          <p>Estado local de la API ANPR y lectura RTSP para deteccion de placas.</p>
        </div>
        ${renderStateLed(Boolean(status.running), status.running ? 'Procesando' : 'Detenido')}
      </div>
      ${renderMetrics([
        { label: 'API ANPR', value: apiRunning ? 'ON' : 'OFF' },
        { label: 'Procesador', value: status.status || (status.running ? 'running' : 'stopped') },
        { label: 'Camaras', value: cameras.length },
        { label: 'RTSP configurados', value: rtspCameras },
        { label: 'Streams activos', value: activeStreams },
        { label: 'PID', value: status.pid || '-' }
      ])}
      ${renderDefinitionList([
        { label: 'Base ANPR', value: cfg.server_url || dashboard().base_url || '-' },
        { label: 'Acceso', value: cfg.id_acceso || dashboard().access?.id || '-' },
        { label: 'Version Bubble', value: cfg.version || '-' },
        { label: 'Apertura automatica', value: 'Por barreras asociadas a cada camara' }
      ])}
    </section>
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Ajustes del procesador ANPR</h4>
          <p>Configura deteccion, validacion de placas y sincronizacion EOLO usada por el procesador local.</p>
        </div>
      </div>
      ${renderAnprConfigForm(cfg)}
    </section>
  `;
}

function renderVehiclePermissionsTable(permissions = []) {
  if (!permissions.length) return '<div class="empty-state compact">Sin PermisoAccesos vehiculares descargados para el acceso activo.</div>';
  return `
    <div class="service-table-wrap">
      <table class="service-table pedestrians-table">
        <thead>
          <tr>
            <th>NombrePrincipal</th>
            <th>ID2</th>
            <th>TipoEntidad</th>
            <th>Tipo Permiso</th>
            <th>Placa</th>
            <th>Codigo QR</th>
            <th>Tarjeta</th>
            <th>Rostro</th>
            <th>AperturaAutomatica</th>
            <th>Detalle</th>
          </tr>
        </thead>
        <tbody>
          ${permissions.map((permission) => `
            <tr>
              <td>
                <strong>${escapeHtml(permission.principal_name || permission.user_name || '-')}</strong>
                <small>${escapeHtml(permission.local_id || permission.id || '')}</small>
              </td>
              <td><code>${escapeHtml(permission.id2_text || permission.id2 || '-')}</code></td>
              <td>${escapeHtml(permission.entity_type || permission.permission_type || 'Vehiculo')}</td>
              <td>${escapeHtml(permissionTypeLabel(permission))}</td>
              <td>${renderInlineCheck(permissionHasPlate(permission))}</td>
              <td>${renderInlineCheck(permission.has_qr)}</td>
              <td>${renderInlineCheck(permission.has_card)}</td>
              <td>${renderInlineCheck(permissionHasFace(permission))}</td>
              <td>${renderInlineCheck(permission.has_automatic_opening)}</td>
              <td>${renderPermissionDetailButton('vehicle', permission)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderPermissionTableToolbar(kind, total = 0) {
  const search = permissionSearchValue(kind);
  const label = kind === 'vehicle' ? 'vehiculares' : 'peatonales';
  return `
    <div class="permission-table-toolbar">
      <form class="permission-search ${search ? 'active' : ''}" data-permission-search-form="${escapeAttr(kind)}">
        <input data-permission-search="${escapeAttr(kind)}" value="${escapeAttr(search)}" placeholder="Buscar permisos ${escapeAttr(label)}" />
        ${search ? `<button type="button" data-permission-search-clear="${escapeAttr(kind)}" aria-label="Limpiar busqueda">×</button>` : ''}
      </form>
      <span>${escapeHtml(total)} resultado${total === 1 ? '' : 's'}</span>
    </div>
  `;
}

function renderPermissionPagination(kind, page = {}) {
  if ((page.totalPages || 1) <= 1) return '';
  return `
    <div class="table-pagination">
      <button type="button" data-permission-page="${escapeAttr(kind)}" data-page="${page.page - 1}" ${page.page <= 1 ? 'disabled' : ''}>Anterior</button>
      <span>Pagina ${escapeHtml(page.page)} de ${escapeHtml(page.totalPages)}</span>
      <button type="button" data-permission-page="${escapeAttr(kind)}" data-page="${page.page + 1}" ${page.page >= page.totalPages ? 'disabled' : ''}>Siguiente</button>
    </div>
  `;
}

function renderInlineCheck(checked) {
  return `<span class="mini-check ${checked ? 'checked' : ''}" aria-label="${checked ? 'Si' : 'No'}">${checked ? '✓' : ''}</span>`;
}

function permissionHasFace(permission = {}) {
  const raw = permission.raw || {};
  const source = raw._source || raw;
  return Boolean(
    permission.has_face ||
      permission.face_image ||
      source.imangenrostro_image ||
      source.imagenrostro_image ||
      source.imagen_rostro_image ||
      source.ImagenRostro ||
      source.ImangenRostro ||
      source.Imagen
  );
}

function permissionHasPlate(permission = {}) {
  const raw = permission.raw || {};
  const source = raw._source || raw;
  return Boolean(
    permission.has_plate ||
      permission.plate ||
      source.placavehiculo_text ||
      source.placa_vehiculo_text ||
      source.placa_text ||
      source.placas_text ||
      source.PlacaVehiculo ||
      source['Placa Vehiculo'] ||
      source.Placa ||
      source.Placas ||
      source.placavehiculo ||
      source.placa ||
      source.placas
  );
}

function normalizePermissionSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function permissionSearchValue(kind) {
  return kind === 'vehicle' ? state.vehiclePermissionSearch : state.pedestrianPermissionSearch;
}

function setPermissionSearchValue(kind, value) {
  if (kind === 'vehicle') {
    state.vehiclePermissionSearch = value;
    state.vehiclePermissionPage = 1;
  } else {
    state.pedestrianPermissionSearch = value;
    state.pedestrianPermissionPage = 1;
  }
}

function permissionPageValue(kind) {
  return kind === 'vehicle' ? state.vehiclePermissionPage : state.pedestrianPermissionPage;
}

function setPermissionPageValue(kind, value) {
  const page = Math.max(1, Number(value || 1));
  if (kind === 'vehicle') state.vehiclePermissionPage = page;
  else state.pedestrianPermissionPage = page;
}

function permissionPageSizeValue(kind) {
  return kind === 'vehicle' ? state.vehiclePermissionPageSize : state.pedestrianPermissionPageSize;
}

function permissionMatchesKind(permission = {}, kind) {
  const raw = permission.raw || {};
  const source = raw._source || raw;
  const entity = normalizePermissionSearch(
    permission.entity_type ||
      source.TipoEntidad ||
      source.Tipo ||
      source.tipo_option_tipo_transporte ||
      source.tipoentidad_option_tipo_entidad ||
      permission.permission_type
  );
  const explicitVehicle =
    entity.includes('vehiculo') ||
    entity.includes('vehicle') ||
    entity.includes('auto');
  const explicitPedestrian =
    entity.includes('persona') ||
    entity.includes('peaton') ||
    entity.includes('pedestrian') ||
    entity.includes('person');
  const vehicle = explicitVehicle || (!explicitPedestrian && Boolean(permission.is_vehicle));
  if (kind === 'vehicle') return vehicle;
  return explicitPedestrian || (!vehicle && Boolean(permission.is_pedestrian !== false));
}

function permissionMatchesSearch(permission = {}, search = '') {
  const needle = normalizePermissionSearch(search);
  if (!needle) return true;
  const raw = permission.raw || {};
  const source = raw._source || raw;
  const haystack = [
    permission.local_id,
    permission.id2_text,
    permission.id2,
    permission.device_user_id,
    permission.id,
    permission.principal_name,
    permission.user_name,
    permission.entity_type,
    permission.permission_type,
    permission.prefix,
    permission.user_id,
    permission.card_number,
    permission.qr_code,
    permission.plate,
    source.NombrePrincipal,
    source.NombreUsuario,
    source.TipoEntidad,
    source.Tipo,
    source.tipo_option_tipo_transporte,
    source.TipoPermisoAcceso,
    source.TipoPermiso,
    source.PlacaVehiculo,
    source.Placa,
    source.Placas,
    source.CodigoQR,
    source.NumeroTarjeta
  ].join(' ');
  return normalizePermissionSearch(haystack).includes(needle);
}

function permissionTypeLabel(permission = {}) {
  const raw = permission.raw || {};
  const source = raw._source || raw;
  const value = displayText(
    permission.permission_type ||
      source.TipoPermiso ||
      source.TipoPermisoAcceso ||
      source.tipopermiso_text ||
      source.tipopermiso_option_tipopermisoacceso
  );
  const normalized = normalizePermissionSearch(value);
  if (normalized.includes('resident')) return 'Residente';
  if (normalized.includes('visit')) return 'Visitante';
  if (permission.id2_text || permission.id2) {
    const id2 = normalizePermissionSearch(permission.id2_text || permission.id2).toUpperCase();
    if (/PR|VR/.test(id2)) return 'Residente';
    if (/PV|VV/.test(id2)) return 'Visitante';
  }
  return value || '-';
}

function renderPermissionDetailButton(kind, permission = {}) {
  const id = permission.id || permission.local_id || permission.id2_text || permission.id2;
  return `
    <button
      type="button"
      class="table-action-button permission-detail-button"
      data-permission-detail-kind="${escapeAttr(kind)}"
      data-permission-detail-id="${escapeAttr(id || '')}"
      ${id ? '' : 'disabled'}
    >
      Ver
    </button>
  `;
}

function permissionRawSource(permission = {}) {
  const raw = permission.raw || {};
  return raw._source || raw;
}

function normalizePermissionFieldKey(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function permissionSourceValue(permission = {}, ...keys) {
  const source = permissionRawSource(permission);
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  const wanted = new Set(keys.map(normalizePermissionFieldKey));
  const found = Object.entries(source).find(([key, value]) =>
    wanted.has(normalizePermissionFieldKey(key)) && value !== undefined && value !== null && value !== ''
  );
  return found ? found[1] : '';
}

function firstPermissionValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    return value;
  }
  return '';
}

function permissionFileUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(permissionFileUrl).find(Boolean) || '';
  if (typeof value === 'object') {
    const nested = firstPermissionValue(
      value.url,
      value.src,
      value.file,
      value.image,
      value.original,
      value.display
    );
    return nested && typeof nested === 'object' ? permissionFileUrl(nested) : String(nested || '').trim();
  }
  return '';
}

function permissionDetailDisplayValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Si' : 'No';
  if (Array.isArray(value)) return value.map(permissionDetailDisplayValue).filter((item) => item !== '-').join(', ') || '-';
  if (typeof value === 'object') return displayText(value) || pretty(value);
  return String(value);
}

function permissionDetailImage(permission = {}) {
  return permissionFileUrl(firstPermissionValue(
    permission.face_image,
    permissionSourceValue(
      permission,
      'imangenrostro_image',
      'imagenrostro_image',
      'imagen_rostro_image',
      'ImagenRostro',
      'ImangenRostro',
      'Imagen Rostro',
      'Imagen',
      'face_image',
      'faceImage'
    )
  ));
}

function permissionDetailRows(permission = {}) {
  const accessRaw = permissionSourceValue(permission, 'acceso_custom_accesos', 'Acceso');
  const residentRaw = permissionSourceValue(
    permission,
    'accesoresidente_custom_accesoresidentes',
    'acceso_residente_custom_accesoresidentes',
    'AccesoResidente',
    'Acceso Residente',
    'Residente'
  );
  const imageUrl = permissionDetailImage(permission);
  return [
    { label: 'NombrePrincipal', value: firstPermissionValue(permission.principal_name, permission.user_name, permissionSourceValue(permission, 'nombreprincipal_text', 'NombrePrincipal', 'Nombre Principal', 'Nombre')) },
    { label: 'PermisoAccesos ID', value: permission.id },
    { label: 'ID2', value: firstPermissionValue(permission.id2_text, permission.id2, permissionSourceValue(permission, 'prefijopermisos_text', 'id2_text', 'ID2', 'Id2', 'ID 2')) },
    { label: 'TipoEntidad', value: firstPermissionValue(permission.entity_type, permissionSourceValue(permission, 'TipoEntidad', 'Tipo Entidad', 'tipoentidad_option_tipo_entidad', 'tipo_option_tipo_transporte', 'Tipo')) },
    { label: 'Tipo Permiso', value: permissionTypeLabel(permission) },
    { label: 'Activo', value: permission.active },
    { label: 'AperturaAutomatica', value: permission.has_automatic_opening },
    { label: 'Acceso', value: firstPermissionValue(permission.access_id, accessRaw) },
    { label: 'AccesoResidente', value: firstPermissionValue(permission.resident_id, residentRaw) },
    { label: 'Usuario', value: firstPermissionValue(permission.user_id, permissionSourceValue(permission, 'usuario_user', 'Usuario', 'user')) },
    { label: 'ID Local', value: firstPermissionValue(permission.local_id, permissionSourceValue(permission, 'idlocal_text', 'IDLocal', 'IdLocal', 'id_local')) },
    { label: 'ID dispositivo', value: firstPermissionValue(permission.device_user_id, permissionSourceValue(permission, 'employeeNo', 'device_user_id', 'id_dispositivo')) },
    { label: 'Placa', value: firstPermissionValue(permission.plate, permissionSourceValue(permission, 'placavehiculo_text', 'placa_vehiculo_text', 'placa_text', 'placas_text', 'PlacaVehiculo', 'Placa Vehiculo', 'Placa', 'Placas')) },
    { label: 'Codigo QR', value: firstPermissionValue(permission.qr_code, permissionSourceValue(permission, 'codigoqr_text', 'codigo_qr_text', 'CodigoQR', 'Codigo QR')) },
    { label: 'NumeroTarjeta', value: firstPermissionValue(permission.card_number, permissionSourceValue(permission, 'numerotarjeta_text', 'numero_tarjeta_text', 'NumeroTarjeta', 'Numero Tarjeta')) },
    { label: 'ImagenRostro', value: imageUrl },
    { label: 'Creado', value: firstPermissionValue(permission.created_at, permissionSourceValue(permission, 'Created Date', 'created_at')) },
    { label: 'Modificado', value: firstPermissionValue(permission.modified_at, permissionSourceValue(permission, 'Modified Date', 'modified_at')) }
  ];
}

function permissionDetailRecord(kind, id) {
  const source = kind === 'vehicle' ? state.vehiclePermissions : state.pedestrianPermissions;
  return (source || []).find((permission) => {
    const values = [permission.id, permission.local_id, permission.id2_text, permission.id2];
    return values.map(String).includes(String(id));
  });
}

function openPermissionDetail(kind, id) {
  const permission = permissionDetailRecord(kind, id);
  if (!permission) return;
  state.selectedPermissionDetail = { kind, id };
  renderPermissionDetailModal();
}

function closePermissionDetail() {
  state.selectedPermissionDetail = null;
  renderPermissionDetailModal();
}

function renderPermissionDetailModal() {
  let root = $('#permissionDetailModalRoot');
  if (!state.selectedPermissionDetail) {
    root?.remove();
    return;
  }
  const { kind, id } = state.selectedPermissionDetail;
  const permission = permissionDetailRecord(kind, id);
  if (!permission) {
    state.selectedPermissionDetail = null;
    root?.remove();
    return;
  }
  if (!root) {
    root = document.createElement('div');
    root.id = 'permissionDetailModalRoot';
    document.body.appendChild(root);
  }
  const rows = permissionDetailRows(permission);
  const imageUrl = permissionDetailImage(permission);
  const title = permissionDetailDisplayValue(firstPermissionValue(permission.principal_name, permission.user_name, 'Permiso'));
  const subtitle = `${kind === 'vehicle' ? 'Vehiculo' : 'Peaton'} · ${permissionDetailDisplayValue(firstPermissionValue(permission.id2_text, permission.id2))}`;
  root.innerHTML = `
    <div class="permission-detail-backdrop">
      <section class="permission-detail-modal" role="dialog" aria-modal="true" aria-labelledby="permissionDetailTitle">
        <header class="permission-detail-header">
          <div>
            <span class="eyebrow">PermisoAccesos</span>
            <h3 id="permissionDetailTitle">${escapeHtml(title)}</h3>
            <p>${escapeHtml(subtitle)}</p>
          </div>
          <button type="button" class="permission-detail-close" data-permission-detail-close aria-label="Cerrar">×</button>
        </header>
        <div class="permission-detail-body">
          <aside class="permission-detail-media">
            ${imageUrl
              ? `<img src="${escapeAttr(imageUrl)}" alt="Imagen rostro de ${escapeAttr(title)}" />`
              : '<div class="permission-detail-placeholder">Sin ImagenRostro</div>'}
          </aside>
          <div class="permission-detail-grid">
            ${rows.map((row) => `
              <div class="permission-detail-item">
                <span>${escapeHtml(row.label)}</span>
                <strong>${escapeHtml(permissionDetailDisplayValue(row.value))}</strong>
              </div>
            `).join('')}
          </div>
          <details class="raw-event permission-detail-raw">
            <summary>
              <span class="raw-chevron">⌄</span>
              <span>Ver datos completos</span>
            </summary>
            <pre>${escapeHtml(pretty(permission.raw || permission))}</pre>
          </details>
        </div>
      </section>
    </div>
  `;
}

function filterPermissionsForTable(permissions = [], kind) {
  const search = permissionSearchValue(kind);
  return permissions
    .filter((permission) => permissionMatchesKind(permission, kind))
    .filter((permission) => permissionMatchesSearch(permission, search));
}

function paginatePermissions(items = [], kind) {
  const pageSize = permissionPageSizeValue(kind);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(permissionPageValue(kind), totalPages);
  const start = (page - 1) * pageSize;
  if (page !== permissionPageValue(kind)) setPermissionPageValue(kind, page);
  return {
    page,
    pageSize,
    total: items.length,
    totalPages,
    items: items.slice(start, start + pageSize)
  };
}

function renderStateLed(active, label) {
  return `
    <span class="state-led ${active ? 'active' : ''}">
      <i aria-hidden="true"></i>
      ${escapeHtml(label)}
    </span>
  `;
}

function summarizePedestrianPermissions(permissions = []) {
  const activePedestrians = permissions.filter((permission) => permission.active !== false && permissionMatchesKind(permission, 'pedestrian'));
  return {
    pedestrians: activePedestrians.length,
    faces: activePedestrians.filter(permissionHasFace).length,
    cards: activePedestrians.filter((permission) => permission.has_card).length,
    codes: activePedestrians.filter((permission) => permission.has_qr).length
  };
}

function summarizeVehiclePermissions(permissions = []) {
  const activeVehicles = permissions.filter((permission) => permission.active !== false && permissionMatchesKind(permission, 'vehicle'));
  return {
    vehicles: activeVehicles.length,
    plates: activeVehicles.filter(permissionHasPlate).length,
    cards: activeVehicles.filter((permission) => permission.has_card).length,
    codes: activeVehicles.filter((permission) => permission.has_qr).length
  };
}

function summarizeOperatorSyncPermissions(permissions = []) {
  const active = permissions.filter((permission) => permission.active !== false);
  const pedestrians = active.filter((permission) => permissionMatchesKind(permission, 'pedestrian'));
  const vehicles = active.filter((permission) => permissionMatchesKind(permission, 'vehicle'));
  return {
    total: permissions.length,
    active: active.length,
    pedestrians: pedestrians.length,
    vehicles: vehicles.length,
    plates: active.filter(permissionHasPlate).length,
    faces: active.filter(permissionHasFace).length,
    cards: active.filter((permission) => permission.has_card).length,
    codes: active.filter((permission) => permission.has_qr).length
  };
}

function syncPermissionSearchValue() {
  return state.syncPermissionSearch || '';
}

function setSyncPermissionSearchValue(value) {
  state.syncPermissionSearch = value;
  state.syncPermissionPage = 1;
}

function filterSyncPermissions(permissions = []) {
  const needle = normalizePermissionSearch(syncPermissionSearchValue());
  if (!needle) return permissions;
  return permissions.filter((permission) => permissionMatchesSearch(permission, needle) || normalizePermissionSearch(pretty(permission.raw || permission)).includes(needle));
}

function paginateSyncPermissions(items = []) {
  const pageSize = state.syncPermissionPageSize || 10;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, Number(state.syncPermissionPage || 1)), totalPages);
  if (page !== state.syncPermissionPage) state.syncPermissionPage = page;
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total: items.length,
    totalPages,
    items: items.slice(start, start + pageSize)
  };
}

function renderSyncPermissionToolbar(total = 0) {
  const search = syncPermissionSearchValue();
  return `
    <div class="permission-table-toolbar">
      <form class="permission-search ${search ? 'active' : ''}" data-sync-permission-search-form>
        <input data-sync-permission-search value="${escapeAttr(search)}" placeholder="Buscar en todos los permisos" />
        ${search ? '<button type="button" data-sync-permission-search-clear aria-label="Limpiar busqueda">×</button>' : ''}
      </form>
      <span>${total} resultado${total === 1 ? '' : 's'}</span>
    </div>
  `;
}

function renderSyncPermissionPagination(page = {}) {
  return `
    <div class="permission-pagination">
      <button type="button" data-sync-permission-page="${page.page - 1}" ${page.page <= 1 ? 'disabled' : ''}>Anterior</button>
      <span>Pagina ${page.page} de ${page.totalPages}</span>
      <button type="button" data-sync-permission-page="${page.page + 1}" ${page.page >= page.totalPages ? 'disabled' : ''}>Siguiente</button>
    </div>
  `;
}

function renderSyncPermissionsTable(permissions = []) {
  if (!permissions.length) return '<div class="empty-state compact">Sin PermisoAccesos para mostrar.</div>';
  return `
    <div class="service-table-wrap">
      <table class="service-table sync-permissions-table">
        <thead>
          <tr>
            <th>NombrePrincipal</th>
            <th>ID2</th>
            <th>TipoEntidad</th>
            <th>Placa</th>
            <th>QR</th>
            <th>Tarjeta</th>
            <th>Rostro</th>
            <th>Apertura</th>
            <th>Propiedades</th>
          </tr>
        </thead>
        <tbody>
          ${permissions.map((permission) => `
            <tr>
              <td>
                <strong>${escapeHtml(permission.principal_name || permission.user_name || '-')}</strong>
                <small>${escapeHtml(permission.local_id || permission.id || '')}</small>
              </td>
              <td><code>${escapeHtml(permission.id2_text || permission.id2 || '-')}</code></td>
              <td>${escapeHtml(permission.entity_type || permission.permission_type || '-')}</td>
              <td>${renderInlineCheck(permissionHasPlate(permission))}</td>
              <td>${renderInlineCheck(permission.has_qr)}</td>
              <td>${renderInlineCheck(permission.has_card)}</td>
              <td>${renderInlineCheck(permissionHasFace(permission))}</td>
              <td>${renderInlineCheck(permission.has_automatic_opening)}</td>
              <td>
                <details class="raw-event sync-permission-raw">
                  <summary>
                    <span class="raw-chevron">⌄</span>
                    <span>Ver</span>
                  </summary>
                  <pre>${escapeHtml(pretty(permission.raw || permission))}</pre>
                </details>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function maskRtspForUi(value = '') {
  const text = String(value || '');
  if (!text || text === '-') return '-';
  return text.replace(/(rtsp:\/\/)([^:@/\s]+):([^@/\s]+)@/i, '$1$2:***@');
}

function normalizedBranchValue(value = '') {
  return String(value || 'live').trim().replace(/^version-/, '') || 'live';
}

function selectedVehicleCamera() {
  if (!state.selectedVehicleCameraIndex) return null;
  if (state.selectedVehicleCameraIndex === 'new') return emptyCamera();
  const index = Number(state.selectedVehicleCameraIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  return vehicleCameras()[index] || null;
}

function selectedBarrier() {
  if (!state.selectedBarrierIndex) return null;
  if (state.selectedBarrierIndex === 'new') return emptyBarrier();
  const index = Number(state.selectedBarrierIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  return barrierDevices()[index] || null;
}

function pedestrianAccessContext() {
  return {
    id:
      localStorage.getItem('eolo.operator.activeAccessId') ||
      state.deviceConfig?.eolo?.access ||
      '',
    name: localStorage.getItem('eolo.operator.activeAccessName') || ''
  };
}

async function maybeLoadManagedFaceDeviceCloudOptions() {
  if (state.activeServiceTab !== 'pedestrians' || state.activePedestrianTab !== 'devices') return;
  if (!state.selectedManagedFaceDeviceId) return;
  const access = pedestrianAccessContext();
  if (!access.id || state.faceDeviceCloudOptionsLoading) return;
  if (state.faceDeviceCloudOptionsAccessId === access.id && state.faceDeviceCloudOptionsLoaded) return;
  await loadManagedFaceDeviceCloudOptions(access.id);
}

async function loadManagedFaceDeviceCloudOptions(accessId) {
  state.faceDeviceCloudOptionsLoading = true;
  state.faceDeviceCloudOptionsAccessId = accessId;
  state.faceDeviceCloudOptionsError = '';
  renderServiceDetail();
  try {
    const query = new URLSearchParams({ access: accessId, _: Date.now() });
    const controlPointsResult = await api(`/api/operator/control-points?${query.toString()}`);
    state.faceDeviceAccessDevices = [];
    state.faceDeviceControlPoints = controlPointsResult.controlPoints || [];
    state.faceDeviceCloudOptionsError = '';
    state.faceDeviceCloudOptionsLoaded = true;
    return {
      controlPoints: state.faceDeviceControlPoints
    };
  } finally {
    state.faceDeviceCloudOptionsLoading = false;
    renderServiceDetail();
  }
}

async function maybeLoadPedestrianPermissions() {
  if (state.activeServiceTab !== 'pedestrians') return;
  const access = pedestrianAccessContext();
  if (!access.id || state.pedestrianPermissionsLoading) return;
  if (state.pedestrianPermissionsAccessId === access.id && state.pedestrianPermissionsLoaded) return;
  await loadPedestrianPermissions().catch((error) => {
    state.pedestrianPermissionsError = error.message;
    renderServiceDetail();
  });
}

function applyOperatorAccessPermissionsResult(result = {}, accessId = '') {
  const permissions = Array.isArray(result.permissions) ? result.permissions : [];
  state.pedestrianPermissions = permissions;
  state.vehiclePermissions = permissions;
  state.syncPermissions = permissions;
  state.pedestrianPermissionsAccessId = accessId;
  state.vehiclePermissionsAccessId = accessId;
  state.pedestrianPermissionSummary = summarizePedestrianPermissions(permissions);
  state.vehiclePermissionSummary = summarizeVehiclePermissions(permissions);
  state.pedestrianPermissionsSource = result.source || '';
  state.vehiclePermissionsSource = result.source || '';
  state.syncPermissionsSource = result.source || '';
  state.syncPermissionsDownloadedAt = result.downloadedAt || state.syncPermissionsDownloadedAt || '';
  state.syncPermissionsValidAfter = result.validAfter || state.syncPermissionsValidAfter || '';
  state.syncPermissionsSkippedExpired = Number(result.skippedExpired || 0);
  state.syncPermissionsSourceCount = Number(result.sourceCount || result.total || permissions.length);
  state.pedestrianPermissionsLoaded = true;
  state.vehiclePermissionsLoaded = true;
  state.syncPermissionsLoaded = true;
  state.pedestrianPermissionsError = '';
  state.vehiclePermissionsError = '';
  state.syncPermissionsError = '';
}

async function loadPedestrianPermissions() {
  const access = pedestrianAccessContext();
  if (!access.id) {
    state.pedestrianPermissions = [];
    state.vehiclePermissions = [];
    state.pedestrianPermissionSummary = summarizePedestrianPermissions([]);
    state.vehiclePermissionSummary = summarizeVehiclePermissions([]);
    state.pedestrianPermissionsError = 'No hay acceso activo seleccionado.';
    renderServiceDetail();
    return null;
  }
  state.pedestrianPermissionsLoading = true;
  state.pedestrianPermissionsAccessId = access.id;
  state.pedestrianPermissionsError = '';
  renderServiceDetail();
  try {
    const query = new URLSearchParams({ access: access.id, _: Date.now() });
    const result = await api(`/api/operator/access-permissions?${query.toString()}`);
    applyOperatorAccessPermissionsResult(result, access.id);
    return result;
  } catch (error) {
    state.pedestrianPermissionsLoaded = true;
    throw error;
  } finally {
    state.pedestrianPermissionsLoading = false;
    renderServiceDetail();
  }
}

async function maybeLoadVehiclePermissions() {
  if (state.activeServiceTab !== 'vehicles') return;
  const access = pedestrianAccessContext();
  if (!access.id || state.vehiclePermissionsLoading) return;
  if (state.vehiclePermissionsAccessId === access.id && state.vehiclePermissionsLoaded) return;
  await loadVehiclePermissions().catch((error) => {
    state.vehiclePermissionsError = error.message;
    renderServiceDetail();
  });
}

async function loadVehiclePermissions() {
  const access = pedestrianAccessContext();
  if (!access.id) {
    state.pedestrianPermissions = [];
    state.vehiclePermissions = [];
    state.pedestrianPermissionSummary = summarizePedestrianPermissions([]);
    state.vehiclePermissionSummary = summarizeVehiclePermissions([]);
    state.vehiclePermissionsError = 'No hay acceso activo seleccionado.';
    renderServiceDetail();
    return null;
  }
  state.vehiclePermissionsLoading = true;
  state.vehiclePermissionsAccessId = access.id;
  state.vehiclePermissionsError = '';
  renderServiceDetail();
  try {
    const query = new URLSearchParams({ access: access.id, _: Date.now() });
    const result = await api(`/api/operator/access-permissions?${query.toString()}`);
    applyOperatorAccessPermissionsResult(result, access.id);
    return result;
  } catch (error) {
    state.vehiclePermissionsLoaded = true;
    throw error;
  } finally {
    state.vehiclePermissionsLoading = false;
    renderServiceDetail();
  }
}

async function maybeLoadIdentificationReaderSettings() {
  if (state.activeServiceTab !== 'identification-reader') return;
  if (state.operatorIdentificationLoading || state.operatorIdentificationLoaded) return;
  await loadIdentificationReaderSettings().catch((error) => {
    state.operatorIdentificationError = error.message;
    renderServiceDetail();
  });
}

async function loadIdentificationReaderSettings() {
  state.operatorIdentificationLoading = true;
  state.operatorIdentificationError = '';
  renderServiceDetail();
  try {
    const access = pedestrianAccessContext();
    const query = new URLSearchParams();
    if (access.id) query.set('access_id', access.id);
    const suffix = query.toString() ? `?${query}` : '';
    const [result, cameras] = await Promise.all([
      api(`/api/operator/vision-config${suffix}`),
      enumerateOperatorCameras().catch(() => [])
    ]);
    state.operatorIdentificationConfig = result.openaiVision || {};
    state.operatorCameras = cameras;
    if (
      state.selectedOperatorCameraId &&
      !state.operatorCameras.some((camera) => camera.deviceId === state.selectedOperatorCameraId)
    ) {
      state.selectedOperatorCameraId = '';
    }
    if (!state.selectedOperatorCameraId && state.operatorCameras[0]?.deviceId) {
      state.selectedOperatorCameraId = state.operatorCameras[0].deviceId;
    }
    state.operatorIdentificationLoaded = true;
    return { config: state.operatorIdentificationConfig, cameras: state.operatorCameras };
  } finally {
    state.operatorIdentificationLoading = false;
    renderServiceDetail();
  }
}

async function enumerateOperatorCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Camara ${index + 1}`
    }));
}

async function maybeLoadCloudSyncSettings() {
  if (state.activeServiceTab !== 'cloud-sync') return;
  if (state.operatorCloudLoading || state.operatorCloudLoaded) return;
  await loadCloudSyncSettings().catch((error) => {
    state.operatorCloudError = error.message;
    renderServiceDetail();
  });
}

async function maybeLoadSyncPermissions() {
  if (state.activeServiceTab !== 'cloud-sync' || state.activeSyncTab !== 'permissions') return;
  const access = pedestrianAccessContext();
  if (!access.id || state.syncPermissionsLoading) return;
  if (state.syncPermissionsLoaded && state.pedestrianPermissionsAccessId === access.id) return;
  await loadSyncPermissions().catch((error) => {
    state.syncPermissionsError = error.message;
    renderServiceDetail();
  });
}

async function loadSyncPermissions() {
  const access = pedestrianAccessContext();
  if (!access.id) {
    state.syncPermissions = [];
    state.syncPermissionsError = 'No hay acceso activo seleccionado.';
    state.syncPermissionsValidAfter = '';
    state.syncPermissionsSkippedExpired = 0;
    state.syncPermissionsSourceCount = 0;
    state.syncPermissionsLoaded = true;
    renderServiceDetail();
    return null;
  }
  state.syncPermissionsLoading = true;
  state.syncPermissionsError = '';
  renderServiceDetail();
  try {
    const query = new URLSearchParams({ access: access.id, _: Date.now() });
    const result = await api(`/api/operator/access-permissions?${query.toString()}`);
    applyOperatorAccessPermissionsResult(result, access.id);
    state.syncPermissions = result.permissions || [];
    state.syncPermissionsSource = result.source || '';
    state.syncPermissionsDownloadedAt = result.downloadedAt || '';
    state.syncPermissionsValidAfter = result.validAfter || '';
    state.syncPermissionsSkippedExpired = Number(result.skippedExpired || 0);
    state.syncPermissionsSourceCount = Number(result.sourceCount || result.total || state.syncPermissions.length);
    state.syncPermissionsLoaded = true;
    return result;
  } finally {
    state.syncPermissionsLoading = false;
    renderServiceDetail();
  }
}

async function maybeLoadSettingsLogs() {
  if (state.activeServiceTab !== 'logs') return;
  if (state.settingsLogsLoading || state.settingsLogsLoaded) return;
  await loadSettingsLogs().catch((error) => {
    state.settingsLogsError = error.message;
    renderServiceDetail();
  });
}

async function loadSettingsLogs() {
  state.settingsLogsLoading = true;
  state.settingsLogsError = '';
  renderServiceDetail();
  try {
    const result = await api(`/api/logs?limit=500&_=${Date.now()}`);
    state.logs = normalizeLogsChronological(result.logs || state.logs || []);
    state.settingsLogsLoaded = true;
    renderLogs();
    updateLatestLog();
    return result;
  } finally {
    state.settingsLogsLoading = false;
    renderServiceDetail();
  }
}

async function loadCloudSyncSettings() {
  state.operatorCloudLoading = true;
  state.operatorCloudError = '';
  renderServiceDetail();
  try {
    const result = await api('/api/operator/cloud-config');
    state.operatorCloudConfig = result.operator || {};
    state.operatorCloudLoaded = true;
    return state.operatorCloudConfig;
  } finally {
    state.operatorCloudLoading = false;
    renderServiceDetail();
  }
}

async function maybeLoadBridgeSettings() {
  if (state.activeServiceTab !== 'bridge-settings') return;
  if (state.operatorBridgeLoaded || state.operatorBridgeLoading) return;
  await loadBridgeSettings().catch((error) => {
    state.operatorBridgeError = error.message;
    renderServiceDetail();
  });
}

async function loadBridgeSettings() {
  state.operatorBridgeLoading = true;
  state.operatorBridgeError = '';
  renderServiceDetail();
  try {
    const result = await api('/api/operator/bridge-settings');
    state.operatorBridgeConfig = result.operator || {};
    state.operatorBridgeLoaded = true;
    updateBridgeBrand();
    return state.operatorBridgeConfig;
  } finally {
    state.operatorBridgeLoading = false;
    renderServiceDetail();
  }
}

function renderBridgeSettingsServiceView() {
  const cfg = state.operatorBridgeConfig || state.operatorCloudConfig || {};
  const access = pedestrianAccessContext();
  const identifier = cfg.effectiveDeviceId || cfg.deviceId || 'Sin consultar';
  const sn = cfg.serialNumber || '';
  const ready = Boolean(identifier && identifier !== 'Sin consultar');
  return `
    <section class="pedestrians-hero-card">
      <div>
        <h3>Ajustes Bridge</h3>
        <p>Administra la identidad local de esta PC/host para sincronizar estado y cambios con EOLO Cloud.</p>
      </div>
      <span class="stream-led-pill ${ready ? 'active' : ''}">
        <i aria-hidden="true"></i>
        ${escapeHtml(ready ? 'Identificado' : 'Pendiente')}
      </span>
    </section>
    ${renderMetrics([
      { label: 'Identificador', value: identifier },
      { label: 'SN', value: sn || '-' },
      { label: 'Cloud', value: cfg.appBaseUrl || '-' },
      { label: 'Rama', value: cfg.branchLabel || cfg.appVersion || '-' }
    ])}
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Identidad del Bridge</h4>
          <p>El identificador es unico para este Bridge local y no se edita desde la interfaz.</p>
        </div>
        <button type="button" data-bridge-settings-refresh ${state.operatorBridgeLoading ? 'disabled' : ''}>
          ${state.operatorBridgeLoading ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>
      ${state.operatorBridgeError ? `<div class="service-warning">${escapeHtml(state.operatorBridgeError)}</div>` : ''}
      ${state.operatorBridgeMessage ? `<p class="form-message ok">${escapeHtml(state.operatorBridgeMessage)}</p>` : ''}
      <form class="anpr-config-form bridge-settings-form" id="bridgeSettingsForm">
        <div class="anpr-config-grid">
          <label class="wide-field">
            Identificador
            <input name="deviceId" value="${escapeAttr(identifier)}" readonly />
          </label>
          <label class="wide-field">
            SN
            <input name="serialNumber" value="${escapeAttr(sn)}" placeholder="SN visible en EOLO Cloud" autocomplete="off" />
          </label>
        </div>
        ${renderDefinitionList([
          { label: 'Acceso activo usado al reflejar', value: access.id || 'Sin acceso activo' },
          { label: 'Workflow heartbeat', value: cfg.deviceHeartbeatWorkflowUrl || 'Sin consultar' },
          { label: 'Tipo de dato Cloud', value: cfg.deviceDataType || 'dispositivosacceso' },
          { label: 'Heartbeat Cloud', value: cfg.deviceHeartbeatEnabled === false ? 'Desactivado' : 'Activo' }
        ])}
        <div class="form-actions">
          <button type="submit" class="primary-button">Guardar y reflejar en Cloud</button>
        </div>
      </form>
      ${state.operatorBridgeLastResult ? `<pre class="json-block face-sync-log">${escapeHtml(pretty(state.operatorBridgeLastResult))}</pre>` : ''}
    </section>
  `;
}

function renderFaceDevicesServiceView() {
  const devices = state.faceDevices || [];
  const selected = selectedManagedFaceDevice();
  const runningCount = devices.filter((item) => item.stream?.running).length;
  const eligibleCount = devices.filter((item) => item.enabled && item.lastTestOk).length;
  const syncReady = selected.enabled && selected.lastTestOk;
  return `
    ${renderMetrics([
      { label: 'Dispositivos', value: devices.length },
      { label: 'Escuchando', value: runningCount },
      { label: 'Elegibles sync', value: eligibleCount },
      { label: 'Tipos', value: `${devices.filter((item) => item.type === 'dahua').length} Dahua / ${devices.filter((item) => item.type === 'hikvision').length} Hikvision` },
      { label: 'Snapshot comun', value: state.health?.eoloUserSync?.cloud?.lastResult ? 'Disponible' : 'Pendiente' }
    ])}
    <div class="face-device-manager">
      <section class="service-section face-device-list">
        <div class="service-section-heading compact">
          <div>
            <h4>Equipos</h4>
            <p>Configuraciones locales independientes para reconocimiento facial.</p>
          </div>
          <div class="inline-actions compact-actions">
            <button type="button" data-face-devices-start-enabled>Iniciar probados</button>
            <button type="button" data-face-devices-stop-all>Detener todos</button>
            <button type="button" data-face-device-new>Nuevo</button>
          </div>
        </div>
        ${devices.length ? devices.map(renderManagedFaceDeviceCard).join('') : '<div class="empty-state compact">Sin dispositivos guardados.</div>'}
      </section>
      <section class="service-section face-device-editor">
        <div class="service-section-heading compact">
          <div>
            <h4>${selected.id === 'new' ? 'Nuevo dispositivo' : escapeHtml(selected.name || 'Dispositivo facial')}</h4>
            <p>${selected.id === 'new' ? 'Captura conexion y tipo de equipo.' : `${deviceTypeLabel(selected.type)} en ${selected.host || '-'}`}</p>
          </div>
          <span class="status-pill ${syncReady ? 'ok' : 'idle'}">${syncReady ? 'probado' : 'pendiente prueba'}</span>
        </div>
        ${selected.id === 'new' ? '' : renderDefinitionList([
          { label: 'Sync', value: syncReady ? 'Incluido en sincronizacion multi-dispositivo' : 'Excluido hasta probar comunicacion' },
          { label: 'Ultima prueba', value: selected.lastTestAt || 'Sin prueba' },
          { label: 'Resultado', value: selected.lastTestMessage || '-' }
        ])}
        <form class="managed-face-device-form" id="managedFaceDeviceForm">
          <div class="form-grid">
            <label>
              Nombre local
              <input name="name" required value="${escapeAttr(selected.name)}" placeholder="Caseta entrada peatones" />
            </label>
            <label>
              Tipo
              <select name="type" data-managed-face-device-type>
                <option value="dahua" ${selected.type === 'dahua' ? 'selected' : ''}>Dahua ASI</option>
                <option value="hikvision" ${selected.type === 'hikvision' ? 'selected' : ''}>Hikvision Mini Moe</option>
              </select>
            </label>
          </div>
          <label>
            Etiqueta local del lector
            <input name="bridgeIdentifier" value="${escapeAttr(selected.bridgeIdentifier)}" placeholder="Dahua ASI entrada" />
          </label>
          <label class="check-row">
            <input name="enabled" type="checkbox" ${selected.enabled ? 'checked' : ''} />
            Habilitar escucha automatica de este equipo
          </label>
          <div class="form-grid">
            <label>
              Protocolo
              <select name="protocol">
                <option value="http" ${selected.protocol !== 'https' ? 'selected' : ''}>http</option>
                <option value="https" ${selected.protocol === 'https' ? 'selected' : ''}>https</option>
              </select>
            </label>
            <label>
              Puerto
              <input name="port" type="number" min="1" max="65535" value="${escapeAttr(selected.port || 80)}" />
            </label>
          </div>
          <label>
            IP o host
            <input name="host" required value="${escapeAttr(selected.host)}" placeholder="192.168.1.75" />
          </label>
          <label>
            Usuario
            <input name="username" required value="${escapeAttr(selected.username)}" autocomplete="username" />
          </label>
          <label>
            ${selected.passwordSet ? 'Nueva contrasena' : 'Contrasena'}
            <input name="password" type="password" autocomplete="current-password" placeholder="${selected.passwordSet ? 'En blanco conserva la guardada' : 'Contrasena del dispositivo'}" />
          </label>
          <label>
            Puerta
            <input name="doorNo" type="number" min="${selected.type === 'dahua' ? '0' : '1'}" max="128" value="${escapeAttr(selected.doorNo ?? (selected.type === 'dahua' ? 0 : 1))}" />
          </label>
          <div class="form-grid" data-managed-type-section="hikvision">
            <label>
              Plan Hikvision
              <input name="planTemplateNo" value="${escapeAttr(selected.planTemplateNo || '1')}" />
            </label>
            <label>
              FDID
              <input name="fdid" value="${escapeAttr(selected.fdid || '1')}" />
            </label>
            <label>
              Libreria facial
              <input name="faceLibType" value="${escapeAttr(selected.faceLibType || 'blackFD')}" />
            </label>
          </div>
          <div class="form-grid" data-managed-type-section="dahua">
            <label>
              ${renderFieldHelp('Tipo tarjeta', 'Codigo numerico que Dahua usa para clasificar la tarjeta al crear o actualizar usuarios en el dispositivo. Normalmente 0 funciona para tarjetas comunes.')}
              <input name="cardType" type="number" min="0" max="255" value="${escapeAttr(selected.cardType ?? 0)}" />
            </label>
            <label>
              ${renderFieldHelp('Vigencia anos', 'Cantidad de anos que tendra vigencia el usuario cargado en el equipo Dahua, desde la fecha de sincronizacion.')}
              <input name="validYears" type="number" min="1" max="50" value="${escapeAttr(selected.validYears || 10)}" />
            </label>
            <label>
              ${renderFieldHelp('Eventos CGI', 'Filtro de eventos que el stream HTTP CGI de Dahua debe escuchar. All mantiene todos los eventos compatibles del equipo.')}
              <input name="eventCodes" value="${escapeAttr(selected.eventCodes || 'All')}" />
            </label>
            <label>
              ${renderFieldHelp('Heartbeat seg.', 'Intervalo de pulso para mantener viva la escucha de eventos Dahua y detectar si el stream dejo de responder.')}
              <input name="heartbeatSeconds" type="number" min="1" max="60" value="${escapeAttr(selected.heartbeatSeconds || 5)}" />
            </label>
          </div>
          <label>
            ${renderFieldHelp('Dedupe seg.', 'Ventana de segundos para ignorar eventos repetidos del mismo rostro, tarjeta o huella y evitar movimientos duplicados.')}
            <input name="dedupWindowSeconds" type="number" min="1" max="120" value="${escapeAttr(selected.dedupWindowSeconds || 8)}" />
          </label>
          <div class="form-actions settings-panel-actions">
            <button type="button" data-face-device-test="${escapeAttr(selected.id)}">Probar</button>
            <button type="button" class="primary-button" data-face-device-save="${escapeAttr(selected.id)}">Guardar</button>
            ${selected.id === 'new' ? '' : `<button type="button" data-face-device-stream="${escapeAttr(selected.id)}" ${syncReady ? '' : 'disabled'}>${selected.stream?.running ? 'Detener escucha' : 'Escuchar eventos'}</button>`}
            ${selected.id === 'new' ? '' : `<button type="button" data-face-device-sync="${escapeAttr(selected.id)}" ${syncReady ? '' : 'disabled'}>Cargar snapshot</button>`}
            ${selected.id === 'new' ? '' : `<button type="button" class="danger" data-face-device-delete="${escapeAttr(selected.id)}">Eliminar</button>`}
          </div>
        </form>
        <pre class="json-block face-device-result">${escapeHtml(pretty(state.faceDeviceLastResult || {}))}</pre>
      </section>
    </div>
  `;
}

function renderManagedFaceDeviceCard(device) {
  const active = device.id === state.selectedManagedFaceDeviceId;
  const eligible = device.enabled && device.lastTestOk;
  return `
    <button class="face-device-card ${active ? 'active' : ''}" type="button" data-face-device-select="${escapeAttr(device.id)}">
      <span class="mini-status ${device.stream?.running ? 'running' : 'stopped'}" aria-hidden="true"></span>
      <span>
        <strong>${escapeHtml(device.name || device.bridgeIdentifier || deviceTypeLabel(device.type))}</strong>
        <small>${escapeHtml(deviceTypeLabel(device.type))} · ${escapeHtml(device.host || '-')}:${escapeHtml(device.port || '-')}</small>
        <small>${eligible ? 'Probado · incluido en sync' : 'Pendiente prueba · fuera de sync'}</small>
      </span>
    </button>
  `;
}

function selectedManagedFaceDevice() {
  if (state.selectedManagedFaceDeviceId === 'new') return emptyManagedFaceDevice();
  return state.faceDevices.find((device) => device.id === state.selectedManagedFaceDeviceId) || emptyManagedFaceDevice();
}

function renderCloudOptionStatus() {
  if (!state.selectedManagedFaceDeviceId) return '';
  if (state.faceDeviceCloudOptionsLoading) {
    return '<p class="form-message">Cargando puntos de control EOLO...</p>';
  }
  if (state.faceDeviceCloudOptionsError) {
    return `
      <div class="service-warning">
        ${escapeHtml(state.faceDeviceCloudOptionsError)}
        <button type="button" class="text-button" data-face-device-cloud-options-retry>Reintentar</button>
      </div>
    `;
  }
  return '';
}

function renderControlPointSelect(selected = {}) {
  const controlPoints = state.faceDeviceControlPoints || [];
  const current = String(selected.controlPointId || '');
  const hasCurrent = !current || controlPoints.some((point) => String(point.id) === current);
  return `
    <select name="controlPointId" data-managed-face-control-point>
      <option value="">Sin asignar</option>
      ${hasCurrent ? '' : `<option value="${escapeAttr(current)}" selected>${escapeHtml(`Guardado: ${current}`)}</option>`}
      ${controlPoints.map((point) => `
        <option value="${escapeAttr(point.id || '')}" ${String(point.id || '') === current ? 'selected' : ''}>
          ${escapeHtml(point.name || point.id || 'Punto de control')}
        </option>
      `).join('')}
    </select>
  `;
}

function renderFieldHelp(label, help) {
  return `
    <span class="field-label-with-help">
      <span>${escapeHtml(label)}</span>
      <span class="field-help-icon" title="${escapeAttr(help)}" aria-label="${escapeAttr(`${label}: ${help}`)}" tabindex="0">?</span>
    </span>
  `;
}

function controlPointNameForId(controlPointId, fallback = '') {
  const point = (state.faceDeviceControlPoints || []).find((item) => String(item.id || '') === String(controlPointId || ''));
  return point?.name || fallback || '';
}

function renderManagedFaceDeviceEditor(selected, options = {}) {
  const access = pedestrianAccessContext();
  const controlPointName = controlPointNameForId(selected.controlPointId, selected.controlPointName);
  return `
    <form class="managed-face-device-form ${options.compact ? 'compact' : ''}" id="managedFaceDeviceForm">
      ${renderCloudOptionStatus()}
      ${!access.id ? '<div class="service-warning">Selecciona un acceso activo para vincular puntos de control y dispositivos EOLO.</div>' : ''}
      <div class="form-grid">
        <label>
          Nombre local
          <input name="name" required value="${escapeAttr(selected.name || '')}" placeholder="Caseta entrada peatones" />
        </label>
        <label>
          Tipo
          <select name="type" data-managed-face-device-type>
            <option value="dahua" ${selected.type === 'dahua' ? 'selected' : ''}>Dahua ASI</option>
            <option value="hikvision" ${selected.type === 'hikvision' ? 'selected' : ''}>Hikvision Mini Moe</option>
          </select>
        </label>
      </div>
      <label>
        Etiqueta local del lector
        <input name="bridgeIdentifier" value="${escapeAttr(selected.bridgeIdentifier || '')}" placeholder="Dahua ASI entrada" />
      </label>
      <label class="check-row">
        <input name="enabled" type="checkbox" ${selected.enabled ? 'checked' : ''} />
        Habilitar escucha automatica de este equipo
      </label>
      <div class="form-grid">
        <label>
          Protocolo
          <select name="protocol">
            <option value="http" ${selected.protocol !== 'https' ? 'selected' : ''}>http</option>
            <option value="https" ${selected.protocol === 'https' ? 'selected' : ''}>https</option>
          </select>
        </label>
        <label>
          Puerto
          <input name="port" type="number" min="1" max="65535" value="${escapeAttr(selected.port || 80)}" />
        </label>
      </div>
      <label>
        IP o host
        <input name="host" required value="${escapeAttr(selected.host || '')}" placeholder="192.168.1.75" />
      </label>
      <label>
        Usuario
        <input name="username" required value="${escapeAttr(selected.username || '')}" autocomplete="username" />
      </label>
      <label>
        ${selected.passwordSet ? 'Nueva contrasena' : 'Contrasena'}
        <input name="password" type="password" autocomplete="current-password" placeholder="${selected.passwordSet ? 'En blanco conserva la guardada' : 'Contrasena del dispositivo'}" />
      </label>
      <div class="form-grid">
        <label>
          ID Punto de control EOLO
          ${renderControlPointSelect(selected)}
        </label>
        <label>
          Nombre punto de control
          <input name="controlPointName" value="${escapeAttr(controlPointName)}" readonly placeholder="Se asigna al elegir punto de control" />
        </label>
        <label>
          Puerta
          <input name="doorNo" type="number" min="${selected.type === 'dahua' ? '0' : '1'}" max="128" value="${escapeAttr(selected.doorNo ?? (selected.type === 'dahua' ? 0 : 1))}" />
        </label>
      </div>
      <div class="form-grid" data-managed-type-section="hikvision">
        <label>
          Plan Hikvision
          <input name="planTemplateNo" value="${escapeAttr(selected.planTemplateNo || '1')}" />
        </label>
        <label>
          FDID
          <input name="fdid" value="${escapeAttr(selected.fdid || '1')}" />
        </label>
        <label>
          Libreria facial
          <input name="faceLibType" value="${escapeAttr(selected.faceLibType || 'blackFD')}" />
        </label>
      </div>
      <div class="form-grid" data-managed-type-section="dahua">
        <label>
          ${renderFieldHelp('Tipo tarjeta', 'Codigo numerico que Dahua usa para clasificar la tarjeta al crear o actualizar usuarios en el dispositivo. Normalmente 0 funciona para tarjetas comunes.')}
          <input name="cardType" type="number" min="0" max="255" value="${escapeAttr(selected.cardType ?? 0)}" />
        </label>
        <label>
          ${renderFieldHelp('Vigencia anos', 'Cantidad de anos que tendra vigencia el usuario cargado en el equipo Dahua, desde la fecha de sincronizacion.')}
          <input name="validYears" type="number" min="1" max="50" value="${escapeAttr(selected.validYears || 10)}" />
        </label>
        <label>
          ${renderFieldHelp('Eventos CGI', 'Filtro de eventos que el stream HTTP CGI de Dahua debe escuchar. All mantiene todos los eventos compatibles del equipo.')}
          <input name="eventCodes" value="${escapeAttr(selected.eventCodes || 'All')}" />
        </label>
        <label>
          ${renderFieldHelp('Heartbeat seg.', 'Intervalo de pulso para mantener viva la escucha de eventos Dahua y detectar si el stream dejo de responder.')}
          <input name="heartbeatSeconds" type="number" min="1" max="60" value="${escapeAttr(selected.heartbeatSeconds || 5)}" />
        </label>
      </div>
      <label>
        ${renderFieldHelp('Dedupe seg.', 'Ventana de segundos para ignorar eventos repetidos del mismo rostro, tarjeta o huella y evitar movimientos duplicados.')}
        <input name="dedupWindowSeconds" type="number" min="1" max="120" value="${escapeAttr(selected.dedupWindowSeconds || 8)}" />
      </label>
      <div class="form-actions settings-panel-actions">
        <button type="button" data-face-device-test="${escapeAttr(selected.id)}">Probar</button>
        <button type="button" class="primary-button" data-face-device-save="${escapeAttr(selected.id)}">Guardar</button>
        ${selected.id === 'new' ? '' : `<button type="button" data-face-device-stream="${escapeAttr(selected.id)}" ${selected.enabled && selected.lastTestOk ? '' : 'disabled'}>${selected.stream?.running ? 'Detener escucha' : 'Escuchar eventos'}</button>`}
        ${selected.id === 'new' ? '' : `<button type="button" data-face-device-sync="${escapeAttr(selected.id)}" ${selected.enabled && selected.lastTestOk ? '' : 'disabled'}>Cargar snapshot</button>`}
        ${selected.id === 'new' ? '' : `<button type="button" class="danger" data-face-device-delete="${escapeAttr(selected.id)}">Eliminar</button>`}
      </div>
    </form>
    <pre class="json-block face-device-result">${escapeHtml(pretty(state.faceDeviceLastResult || {}))}</pre>
  `;
}

function emptyManagedFaceDevice() {
  return {
    id: 'new',
    type: 'dahua',
    enabled: true,
    name: '',
    bridgeIdentifier: '',
    localDeviceId: '',
    controlPointId: '',
    controlPointName: '',
    protocol: 'http',
    host: '',
    port: 80,
    username: '',
    passwordSet: false,
    doorNo: 0,
    planTemplateNo: '1',
    fdid: '1',
    faceLibType: 'blackFD',
    cardType: 0,
    validYears: 10,
    dedupWindowSeconds: 8,
    eventCodes: 'All',
    heartbeatSeconds: 5,
    stream: { running: false }
  };
}

function deviceTypeLabel(type) {
  return type === 'dahua' ? 'Dahua ASI' : 'Hikvision Mini Moe';
}

function renderHikvisionServiceView() {
  const configActive = state.activeFaceRecognitionTab === 'config';
  const employeesActive = state.activeFaceRecognitionTab === 'employees';
  return `
    <div class="service-inner-tabs face-device-tabs" role="tablist" aria-label="Tipo de equipo de reconocimiento facial">
      <button class="service-inner-tab ${state.activeFaceDeviceTab === 'hikvision' ? 'active' : ''}" type="button" data-face-device-tab="hikvision">Hikvision Mini Moe</button>
      <button class="service-inner-tab ${state.activeFaceDeviceTab === 'dahua' ? 'active' : ''}" type="button" data-face-device-tab="dahua">Dahua ASI</button>
    </div>
    <div class="service-inner-tabs" role="tablist" aria-label="Reconocimiento Facial">
      <button class="service-inner-tab ${!employeesActive && !configActive ? 'active' : ''}" type="button" data-face-tab="operation">Estado</button>
      <button class="service-inner-tab ${configActive ? 'active' : ''}" type="button" data-face-tab="config">Configuracion</button>
      <button class="service-inner-tab ${employeesActive ? 'active' : ''}" type="button" data-face-tab="employees">Empleados</button>
    </div>
    ${configActive ? renderFaceConfigView() : employeesActive ? renderFaceEmployeesView() : renderFaceOperationView()}
  `;
}

function renderFaceConfigView() {
  const deviceLabel = state.activeFaceDeviceTab === 'dahua' ? 'Dahua ASI6213S-D' : 'Hikvision Mini Moe';
  return `
    <section class="service-section wide face-config-section">
      <div class="service-section-heading">
        <div>
          <h4>Configuracion ${escapeHtml(deviceLabel)}</h4>
          <p>Conexion local y sincronizacion separada entre EOLO Cloud, snapshot local y dispositivo.</p>
        </div>
      </div>
      <div class="face-config-mount" id="faceConfigMount"></div>
    </section>
  `;
}

function renderFaceSyncPanels() {
  const cloudMount = $('#cloudSyncPanelMount');
  const deviceMount = $('#deviceSyncPanelMount');
  if (cloudMount) cloudMount.innerHTML = renderCloudSyncPanel();
  if (deviceMount) deviceMount.innerHTML = renderDeviceSyncPanel();
}

function renderCloudSyncPanel() {
  const cloud = state.health?.eoloUserSync?.cloud || {};
  const status = cloud.running ? 'procesando' : cloud.lastError ? 'error' : cloud.lastResult ? 'exito' : 'pendiente';
  return `
    <section class="face-sync-panel">
      <h4>Resultado Sincronizacion Cloud</h4>
      ${renderDefinitionList([
        { label: 'Estado', value: status },
        { label: 'Ultima descarga', value: cloud.lastRunAt || 'Sin ejecucion' },
        { label: 'Snapshot local', value: cloud.lastResult ? `${cloud.lastResult.validCloudCount || 0} validos` : 'Sin snapshot' },
        { label: 'Error', value: cloud.lastError || '-' }
      ])}
      <div class="inline-actions">
        <button type="button" data-download-cloud-users>Descargar accesoresidentes</button>
      </div>
      <pre class="json-block face-sync-log" id="cloudSyncInfo">${escapeHtml(pretty(cloud.lastResult || cloud.lastError || {}))}</pre>
    </section>
  `;
}

function renderDeviceSyncPanel() {
  const deviceSync = state.health?.eoloUserSync?.device || {};
  const settings = faceDeviceSettings();
  const eligible = state.health?.eoloUserSync?.eligibleFaceDevices ?? state.faceDevices.filter((device) => device.enabled && device.lastTestOk).length;
  const total = state.health?.eoloUserSync?.totalFaceDevices ?? state.faceDevices.length;
  const status = deviceSync.running ? 'procesando' : deviceSync.lastError ? 'error' : deviceSync.lastResult ? 'exito' : 'pendiente';
  return `
    <section class="face-sync-panel">
      <h4>Resultado Sincronizacion Dispositivo</h4>
      ${renderDefinitionList([
        { label: 'Estado', value: status },
        { label: 'Ultima carga', value: deviceSync.lastRunAt || 'Sin ejecucion' },
        { label: 'Dispositivos elegibles', value: `${eligible}/${total}` },
        { label: 'Legacy activo', value: `${settings?.host || '-'}:${settings?.port || '-'}` },
        { label: 'Error', value: deviceSync.lastError || '-' }
      ])}
      <div class="inline-actions">
        <button type="button" data-apply-device-users>Cargar a dispositivos probados</button>
      </div>
      <pre class="json-block face-sync-log" id="deviceSyncInfo">${escapeHtml(pretty(deviceSync.lastResult || deviceSync.lastError || {}))}</pre>
    </section>
  `;
}

function renderFaceOperationView() {
  const stream = state.health?.stream || {};
  const device = faceDeviceSettings();
  const events = state.events.slice(-20).reverse();
  return `
    ${renderMetrics([
      { label: 'Estado stream', value: stream.running ? 'Activo' : 'Detenido' },
      { label: 'Eventos en memoria', value: state.events.length },
      { label: 'Dispositivo', value: device.host || state.health?.deviceHost || '-' },
      { label: 'Modo', value: state.health?.mode || '-' }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>Proceso</h4>
        ${renderFaceEventToggle()}
        ${renderDefinitionList([
          { label: 'Destino', value: `${device.protocol || state.health?.deviceProtocol || 'http'}://${device.host || state.health?.deviceHost || '-'}:${device.port || state.health?.devicePort || '-'}` },
          { label: 'Puerta', value: device.doorNo || '-' },
          { label: 'Ventana anti-duplicados', value: `${device.dedupWindowSeconds || '-'} s` }
        ])}
      </section>
      <section class="service-section">
        <h4>Registro reciente</h4>
        ${renderTable(
          [
            { label: 'Empleado', value: (row) => row.employeeNo || row.name },
            { label: 'Nombre', value: 'name' },
            { label: 'Modo', value: 'currentVerifyMode' },
            { label: 'Hora', value: (row) => row.dateTime || row.receivedAt }
          ],
          events,
          'Sin eventos Hikvision recibidos.'
        )}
      </section>
    </div>
  `;
}

function renderFaceEventToggle() {
  return `
    <button
      class="event-toggle service-event-toggle"
      id="streamBtn"
      type="button"
      role="switch"
      aria-checked="false"
      disabled
      title="Valida la comunicacion con el dispositivo local para escuchar eventos"
    >
      <span class="event-toggle-track" aria-hidden="true">
        <span class="event-toggle-knob"></span>
      </span>
      <span class="event-toggle-copy">
        <strong>Escuchar Eventos Dispositivo</strong>
        <small id="streamToggleStatus">Validacion requerida</small>
      </span>
    </button>
  `;
}

function renderFaceEmployeesView() {
  return '<div class="face-employees-mount" id="faceEmployeesMount"></div>';
}

function renderEoloUsersServiceView() {
  const sync = state.health?.eoloUserSync || {};
  const sessionTokenSources = ['active-operator-session', 'request-operator-session'];
  const tokenLabel =
    sessionTokenSources.includes(sync.tokenSource)
      ? 'Sesion operador'
      : sync.tokenSource === 'saved-config-token'
        ? 'Guardado'
        : localStorage.getItem('eolo.operator.token')
          ? 'Sesion navegador'
          : 'Pendiente';
  const scheduledTokenLabel = sessionTokenSources.includes(sync.scheduledTokenSource)
    ? 'Sesion operador'
    : 'Pendiente';
  return `
    ${renderMetrics([
      { label: 'Servicio', value: serviceIsRunning('eolo-users-sync') ? 'Activo' : 'Detenido' },
      { label: 'Intervalo', value: `${sync.intervalMinutes || '-'} min` },
      { label: 'Ultima corrida', value: sync.lastRunAt || 'Sin ejecucion' },
      { label: 'Configuracion', value: sync.enabled ? 'Habilitada' : 'Deshabilitada' }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>Conectividad EOLO</h4>
        ${renderDefinitionList([
          { label: 'Acceso', value: sync.accessSet ? 'Configurado' : 'Pendiente' },
          { label: 'Identidad Bridge', value: sync.localDeviceIdSet ? 'Configurada' : 'Pendiente' },
          { label: 'Token', value: tokenLabel },
          { label: 'Token automatico', value: scheduledTokenLabel },
          { label: 'Usuario sesion', value: sync.operatorUserId || '-' },
          { label: 'Descarga Cloud', value: sync.cloud?.running ? 'Procesando' : sync.cloud?.lastRunAt || 'Sin ejecucion' },
          { label: 'Carga dispositivo', value: sync.device?.running ? 'Procesando' : sync.device?.lastRunAt || 'Sin ejecucion' }
        ])}
        <div class="inline-actions">
          <button type="button" data-download-cloud-users>Descargar Cloud</button>
          <button type="button" data-apply-device-users>Cargar dispositivo</button>
        </div>
      </section>
      <section class="service-section">
        <h4>Directorio local</h4>
        ${renderMetrics([
          { label: 'Empleados cargados en vista', value: state.employees.length },
          { label: 'Total ultima busqueda', value: state.employeePage.total }
        ])}
      </section>
    </div>
  `;
}

function renderEoloTasksServiceView() {
  const service = serviceById('eolo-task-poller');
  const logs = state.logs
    .filter((record) => String(record.message || '').toLowerCase().includes('tarea') || String(record.source || '').includes('task'))
    .slice(-20)
    .reverse();
  return `
    ${renderMetrics([
      { label: 'Polling', value: service.running ? 'Activo' : 'Detenido' },
      { label: 'Servicio habilitado', value: service.enabled ? 'Si' : 'No' },
      { label: 'Estado', value: service.status || '-' },
      { label: 'Logs relacionados', value: logs.length }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>Control</h4>
        ${renderServiceActions('eolo-task-poller', {
          extra: '<button type="button" data-run-task-poll>Consultar tareas</button>'
        })}
      </section>
      <section class="service-section">
        <h4>Registro</h4>
        ${renderTable(
          [
            { label: 'Hora', value: 'ts' },
            { label: 'Nivel', value: 'level' },
            { label: 'Mensaje', value: (row) => formatLogMessage(row) }
          ],
          logs,
          'Sin logs recientes de tareas.'
        )}
      </section>
    </div>
  `;
}

function renderAnprApiServiceView() {
  const cfg = anprConfig();
  return `
    ${renderAnprUnavailable()}
    ${renderMetrics([
      { label: 'Camara(s)', value: (cfg.cameras || []).length },
      { label: 'Barrera(s)', value: (cfg.barriers || []).length },
      { label: 'Bubble', value: cfg.bubble_token_set ? 'Token guardado' : 'Sin token' },
      { label: 'Version', value: cfg.version || '-' }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>Configuracion general</h4>
        ${renderDefinitionList([
          { label: 'Servidor ANPR', value: cfg.server_url || '-' },
          { label: 'ID acceso', value: cfg.id_acceso || '-' },
          { label: 'Archivo DB', value: dashboard().db_file || '-' }
        ])}
      </section>
      <section class="service-section">
        <h4>Filtros de deteccion</h4>
        ${renderDefinitionList([
          { label: 'Min. ancho placa', value: cfg.min_plate_width_ratio ?? '-' },
          { label: 'Min. alto placa', value: cfg.min_plate_height_ratio ?? '-' },
          { label: 'Validacion estricta', value: cfg.strict_plate_validation !== false ? 'Si' : 'No' },
          { label: 'Requiere vehiculo', value: cfg.require_vehicle_detection ? 'Si' : 'No' },
          { label: 'Confianza vehiculo', value: cfg.min_vehicle_confidence ?? '-' }
        ])}
      </section>
    </div>
  `;
}

function renderAnprProcessorServiceView() {
  const cfg = anprConfig();
  const access = dashboard().access || {};
  const status = anprService('anpr-processor');
  const hardware = anprHardware();
  const activeTab = state.activeAnprProcessorTab || 'summary';
  const tabs = [
    { id: 'summary', label: 'Resumen' },
    { id: 'cameras', label: 'Cámaras' },
    { id: 'movements', label: 'Movimientos' }
  ];
  const tabContent = {
    summary: `
      ${renderMetrics([
        { label: 'Proceso', value: status.running ? 'Activo' : 'Detenido' },
        { label: 'PID', value: status.pid || '-' },
        { label: 'Cámaras', value: (cfg.cameras || []).length },
        { label: 'Barreras', value: (cfg.barriers || []).length },
        { label: 'Movimientos', value: (access.movements || []).length },
        { label: 'Pendientes sync', value: access.pending_sync_count ?? '-' }
      ])}
      <div class="service-section-grid">
        <section class="service-section">
          <h4>Control del proceso</h4>
          ${renderServiceActions('anpr-processor')}
          ${renderDefinitionList([
            { label: 'Deteccion', value: status.running ? 'Procesando streams activos' : 'En espera' },
            { label: 'Apertura automatica', value: 'Por barreras asociadas a cada cámara' }
          ])}
        </section>
        <section class="service-section">
          <h4>Cámaras vinculadas</h4>
          ${renderTable(
            [
              { label: 'Nombre', value: 'name' },
              { label: 'Tipo', value: 'type' },
              { label: 'Prefijo', value: 'prefix' },
              { label: 'Barreras', value: 'barrier_count' }
            ],
            cfg.cameras || [],
            'Sin cámaras ANPR configuradas.'
          )}
        </section>
      </div>
    `,
    cameras: `
      ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
      <div class="camera-config-layout">
        <section class="service-section wide">
          <h4>Parámetros ANPR</h4>
          ${renderAnprConfigForm(cfg)}
        </section>
        <section class="service-section wide camera-editor-section">
          <h4>Cámaras ANPR</h4>
          ${renderCameraHardwareEditor(hardware)}
        </section>
      </div>
    `,
    movements: `
      <section class="service-section wide">
        <h4>Movimientos de acceso</h4>
        ${renderAccessMovementsTable(access.movements || [])}
      </section>
    `
  };
  return `
    ${renderAnprUnavailable()}
    <div class="service-inner-tabs">
      ${tabs
        .map(
          (tab) => `
            <button type="button" class="${activeTab === tab.id ? 'active' : ''}" data-anpr-processor-tab="${tab.id}">
              ${escapeHtml(tab.label)}
            </button>
          `
        )
        .join('')}
    </div>
    ${tabContent[activeTab] || tabContent.summary}
  `;
}

function renderAnprConfigForm(cfg = anprConfig()) {
  return `
    <form class="anpr-config-form" id="anprConfigForm">
      <div class="anpr-config-grid">
        <label class="wide-field">
          Server ANPR
          <input name="server_url" value="${escapeHtml(cfg.server_url || '')}" placeholder="https://..." />
        </label>
        <label>
          Version Bubble
          <select name="version">
            <option value="test" ${cfg.version === 'test' ? 'selected' : ''}>test</option>
            <option value="live" ${cfg.version === 'live' ? 'selected' : ''}>live</option>
          </select>
        </label>
        <label>
          ID acceso
          <input name="id_acceso" value="${escapeHtml(cfg.id_acceso || '')}" placeholder="ID Bubble" />
        </label>
        <label class="wide-field">
          Token Bubble
          <input name="bubble_token" type="password" placeholder="${cfg.bubble_token_set ? 'Token guardado - escribir para reemplazar' : 'Token Bubble'}" />
        </label>
        <label>
          Min. ancho placa
          <input name="min_plate_width_ratio" type="number" min="0" max="1" step="0.001" value="${escapeHtml(cfg.min_plate_width_ratio ?? 0.02)}" />
        </label>
        <label>
          Min. alto placa
          <input name="min_plate_height_ratio" type="number" min="0" max="1" step="0.001" value="${escapeHtml(cfg.min_plate_height_ratio ?? 0.02)}" />
        </label>
        <label>
          Confianza vehiculo
          <input name="min_vehicle_confidence" type="number" min="0" max="1" step="0.01" value="${escapeHtml(cfg.min_vehicle_confidence ?? 0.78)}" />
        </label>
        <label class="toggle-field">
          <input name="strict_plate_validation" type="checkbox" ${cfg.strict_plate_validation !== false ? 'checked' : ''} />
          <span>Validación estricta de placa</span>
        </label>
        <label class="toggle-field">
          <input name="require_vehicle_detection" type="checkbox" ${cfg.require_vehicle_detection ? 'checked' : ''} />
          <span>Requiere vehículo detectado</span>
        </label>
      </div>
      <div class="form-actions">
        <button type="submit">Guardar parámetros</button>
      </div>
    </form>
  `;
}

function renderBarriersServiceView() {
  const barriers = barrierDevices();
  const associated = associatedBarrierCount();
  return `
    ${renderAnprUnavailable()}
    ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
    <section class="pedestrians-hero-card">
      <div>
        <h3>Puertas y Barreras</h3>
        <p>Administra los dispositivos locales de apertura asociados a camaras, accesos vehiculares y operaciones manuales.</p>
      </div>
      <span class="stream-led-pill ${associated ? 'active' : ''}">
        <i aria-hidden="true"></i>
        ${escapeHtml(`${associated} ${associated === 1 ? 'asociada' : 'asociadas'}`)}
      </span>
    </section>
    ${renderMetrics([
      { label: 'Dispositivos', value: barriers.length },
      { label: 'Activos', value: associated }
    ])}
    ${renderBarrierDevicesView()}
  `;
}

function renderBarrierDevicesView() {
  const selected = selectedBarrier();
  return selected ? `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact device-editor-heading">
        <button type="button" class="icon-button chevron-back-button" data-barrier-back aria-label="Regresar a puertas y barreras">
          <span aria-hidden="true">‹</span>
        </button>
        <div class="device-editor-title">
          <h4>${state.selectedBarrierIndex === 'new' ? 'Nueva puerta o barrera' : `Editar ${escapeHtml(barrierId(selected) || 'barrera')}`}</h4>
          <p>${state.selectedBarrierIndex === 'new' ? 'Configura el dispositivo local de apertura.' : `${barrierTypeLabel(selected.type)} · ${selected.ip_puerto || '-'}`}</p>
        </div>
        ${renderStateLed(barrierIsAssociated(selected), barrierIsAssociated(selected) ? 'Asociada' : 'Sin asociar')}
      </div>
      ${renderBarrierEditor(selected)}
    </section>
  ` : `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Puertas y barreras registradas</h4>
          <p>Dispositivos locales disponibles para apertura manual o apertura automatica desde camaras ANPR.</p>
        </div>
        <button type="button" class="primary-button" data-barrier-new>Nueva Barrera</button>
      </div>
      ${renderBarriersTable(barrierDevices())}
    </section>
  `;
}

function renderBarriersTable(barriers = []) {
  if (!barriers.length) return '<div class="empty-state compact">Sin puertas o barreras registradas localmente.</div>';
  return `
    <div class="service-table-wrap">
      <table class="service-table pedestrians-table">
        <thead>
          <tr>
            <th>Identificador</th>
            <th>Numero</th>
            <th>IP / Puerto</th>
            <th>Tipo</th>
            <th>Asociacion</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${barriers.map((barrier, index) => `
            <tr>
              <td><strong>${escapeHtml(barrierId(barrier) || `Barrera ${index + 1}`)}</strong></td>
              <td>${escapeHtml(barrier.numero_barra || '-')}</td>
              <td>${escapeHtml(barrier.ip_puerto || '-')}</td>
              <td>${escapeHtml(barrierTypeLabel(barrier.type))}</td>
              <td>${renderStateLed(barrierIsAssociated(barrier), barrierIsAssociated(barrier) ? 'Asociada' : 'Sin asociar')}</td>
              <td><button type="button" data-barrier-edit="${index}">Editar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderBarrierEditor(barrier = emptyBarrier()) {
  return `
    <form class="hardware-form barrier-device-form" id="barrierDeviceForm">
      <div class="hardware-editor-block">
        <div class="hardware-row barrier-row" data-barrier-row>
          <label>
            Tipo
            <select name="barrier_type">
              <option value="hikvision-isapi" ${(barrier.type || 'hikvision-isapi') === 'hikvision-isapi' ? 'selected' : ''}>Hikvision ISAPI</option>
            </select>
          </label>
          <label>
            ID Barra
            <input name="barrier_id" value="${escapeAttr(barrier.id_barra || '')}" placeholder="barra-entrada" />
          </label>
          <label>
            Numero
            <input name="barrier_number" value="${escapeAttr(barrier.numero_barra || '')}" placeholder="1" />
          </label>
          <label>
            IP y puerto
            <input name="barrier_ip" value="${escapeAttr(barrier.ip_puerto || '')}" placeholder="192.168.1.10:80" />
          </label>
          <label>
            Usuario
            <input name="barrier_user" value="${escapeAttr(barrier.usuario || '')}" placeholder="admin" />
          </label>
          <label>
            ${barrier.password ? 'Nueva contrasena' : 'Contrasena'}
            <input name="barrier_password" type="password" placeholder="${barrier.password ? 'En blanco conserva la guardada' : 'Contrasena'}" />
          </label>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" data-barrier-back>Cancelar</button>
        <button type="submit" class="primary-button">Guardar</button>
      </div>
      ${state.barrierLastResult ? `<pre class="face-device-result">${escapeHtml(pretty(state.barrierLastResult))}</pre>` : ''}
    </form>
  `;
}

function renderRtspPreviewServiceView() {
  return renderWebrtcPreviewServiceView();
}

function renderWebrtcPreviewServiceView() {
  const hardware = anprHardware();
  const status = serviceById('webrtc-preview') || {};
  const cameraCount = (hardware.cameras || []).length || (anprConfig().cameras || []).length;
  return `
    ${renderAnprUnavailable()}
    ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
    <section class="pedestrians-hero-card">
      <div>
        <h3>Visualizador RTC</h3>
        <p>Administra la visualizacion local de camaras RTSP en baja latencia para el navegador.</p>
      </div>
      <div class="vehicle-hero-actions">
        ${renderStateLed(Boolean(status.running), status.running ? 'Activo' : 'Detenido')}
        ${renderServiceActions('webrtc-preview', { compact: true })}
      </div>
    </section>
    ${renderMetrics([
      { label: 'Visualizador', value: status.running ? 'Activo' : 'Detenido' },
      { label: 'PID', value: status.pid || '-' },
      { label: 'Camara(s)', value: cameraCount },
      { label: 'Puerto ICE', value: status.port || '8555' }
    ])}
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Conexion RTC</h4>
          <p>Parametros locales usados para publicar y consumir video dentro de la red.</p>
        </div>
      </div>
      ${renderDefinitionList([
        { label: 'WebUI', value: status.publicUrl || 'http://localhost:1984' },
        { label: 'API interna', value: status.apiUrl || 'http://127.0.0.1:1984' },
        { label: 'HTTP', value: '1984/tcp' },
        { label: 'ICE', value: status.port ? `${status.port}/tcp + ${status.port}/udp` : '8555/tcp + 8555/udp' },
        { label: 'LAN', value: 'ANPR_WEBRTC_ICE_HOST=IP del equipo Docker' },
        { label: 'Recomendacion', value: 'Usar H.264/substream para menor carga' }
      ])}
    </section>
  `;
}

function renderIdentificationReaderServiceView() {
  const cfg = state.operatorIdentificationConfig || {};
  const cameras = state.operatorCameras || [];
  const selectedCamera = cameras.find((camera) => camera.deviceId === state.selectedOperatorCameraId);
  const ready = Boolean((cfg.effectiveEnabled ?? cfg.enabled) && cfg.effectiveApiKeySet);
  const keyLabel = cfg.effectiveApiKeyLabel || (cfg.apiKeySet ? 'Local' : 'Sin key');
  return `
    <section class="pedestrians-hero-card">
      <div>
        <h3>Lectura de Identificaciones</h3>
        <p>Configura la camara local y OpenAI Vision para leer datos desde fotografias de identificaciones.</p>
      </div>
      <span class="stream-led-pill ${ready ? 'active' : ''}">
        <i aria-hidden="true"></i>
        ${ready ? 'Vision activa' : 'Vision inactiva'}
      </span>
    </section>
    ${renderMetrics([
      { label: 'Camaras', value: state.operatorIdentificationLoading ? '...' : cameras.length },
      { label: 'Camara activa', value: selectedCamera?.label || (state.selectedOperatorCameraId ? 'Seleccionada' : 'Sin seleccionar') },
      { label: 'OpenAI', value: cfg.effectiveApiKeySet ? `Key ${keyLabel}` : 'Sin key' },
      { label: 'Origen key', value: keyLabel },
      { label: 'Modelo', value: cfg.model || '-' }
    ])}
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Camara y Vision</h4>
          <p>Estos ajustes se usan desde el panel Operador al capturar una identificacion.</p>
        </div>
        <button type="button" data-identification-refresh ${state.operatorIdentificationLoading ? 'disabled' : ''}>
          ${state.operatorIdentificationLoading ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>
      ${state.operatorIdentificationError ? `<div class="service-warning">${escapeHtml(state.operatorIdentificationError)}</div>` : ''}
      <form class="anpr-config-form" id="identificationReaderForm">
        <div class="identification-settings-groups">
          <fieldset class="identification-settings-group">
            <legend>Camara</legend>
            <label>
              Camara local
              <select name="cameraId">
                ${cameras.length
                  ? cameras.map((camera, index) => `
                    <option value="${escapeAttr(camera.deviceId)}" ${camera.deviceId === state.selectedOperatorCameraId ? 'selected' : ''}>
                      ${escapeHtml(camera.label || `Camara ${index + 1}`)}
                    </option>
                  `).join('')
                  : '<option value="">Sin camaras detectadas</option>'}
              </select>
            </label>
          </fieldset>
          <fieldset class="identification-settings-group">
            <legend>Vision</legend>
            <div class="anpr-config-grid">
              <label class="toggle-field">
                <input name="enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''} />
                <span>Activar lectura con OpenAI Vision</span>
              </label>
              <label>
                Modelo
                <input name="model" value="${escapeAttr(cfg.model || 'gpt-4o-mini')}" placeholder="gpt-4o-mini" />
              </label>
              <label class="toggle-field">
                <input name="changeApiKey" type="checkbox" ${cfg.apiKeySet ? '' : 'checked'} ${cfg.apiKeySet ? '' : 'disabled'} />
                <span>Cambiar API key</span>
              </label>
              <label class="wide-field">
                API key de OpenAI
                <input name="apiKey" type="password" autocomplete="off" placeholder="${cfg.apiKeySet ? 'API key guardada; activa cambiar para reemplazarla' : 'Captura una API key para activar Vision'}" ${cfg.apiKeySet ? 'disabled' : ''} />
              </label>
            </div>
          </fieldset>
        </div>
        <p class="muted-inline">${cfg.effectiveApiKeySet ? `La lectura usara la API key de origen ${keyLabel}.` : 'No hay API key disponible en el acceso activo ni en ajustes locales.'}</p>
        ${state.operatorIdentificationMessage ? `<p class="form-message ok">${escapeHtml(state.operatorIdentificationMessage)}</p>` : ''}
        <div class="form-actions">
          <button type="submit" class="primary-button">Guardar</button>
        </div>
      </form>
    </section>
  `;
}

function renderCloudSyncServiceView() {
  const cfg = state.operatorCloudConfig || {};
  const version = normalizedBranchValue(cfg.appVersion || 'live');
  const preset = ['live', 'test', '13i8l', '73hi5'].includes(version) ? version : 'custom';
  const branchLabel = cfg.branchLabel || (version === 'live' ? 'Produccion' : version);
  const ready = Boolean(cfg.appBaseUrl && cfg.workflowBaseUrl);
  const sync = state.health?.eoloUserSync || {};
  const permissions = state.syncPermissions.length ? state.syncPermissions : state.pedestrianPermissions;
  const summary = summarizeOperatorSyncPermissions(permissions);
  return `
    <section class="pedestrians-hero-card">
      <div>
        <h3>Sincronizacion</h3>
        <p>Administra la comunicacion con EOLO Cloud, la descarga local de permisos y la carga automatica a dispositivos.</p>
      </div>
      <span class="stream-led-pill ${ready ? 'active' : ''}">
        <i aria-hidden="true"></i>
        ${escapeHtml(sync.processing ? 'Procesando' : branchLabel)}
      </span>
    </section>
    ${renderMetrics([
      { label: 'Cloud', value: cfg.appBaseUrl || '-' },
      { label: 'Rama', value: branchLabel },
      { label: 'Permisos', value: summary.total },
      { label: 'Snapshot facial', value: sync.cloud?.lastResult ? `${sync.cloud.lastResult.validCloudCount || 0} usuarios` : 'Pendiente' },
      { label: 'Auto', value: sync.enabled ? `${sync.intervalMinutes || '-'} min` : 'Inactiva' },
      { label: 'Dispositivos', value: `${sync.eligibleFaceDevices ?? 0}/${sync.totalFaceDevices ?? state.faceDevices.length}` }
    ])}
    <div class="service-inner-tabs sync-tabs" role="tablist" aria-label="Sincronizacion">
      <button class="service-inner-tab ${state.activeSyncTab === 'cloud' ? 'active' : ''}" type="button" data-sync-tab="cloud">Cloud</button>
      <button class="service-inner-tab ${state.activeSyncTab === 'permissions' ? 'active' : ''}" type="button" data-sync-tab="permissions">Permisos</button>
      <button class="service-inner-tab ${state.activeSyncTab === 'devices' ? 'active' : ''}" type="button" data-sync-tab="devices">Dispositivos</button>
    </div>
    ${state.activeSyncTab === 'permissions'
      ? renderSyncPermissionsTab()
      : state.activeSyncTab === 'devices'
        ? renderSyncDevicesTab()
        : renderSyncCloudTab({ cfg, preset })}
  `;
}

function renderSyncCloudTab({ cfg, preset }) {
  return `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Cloud</h4>
          <p>Estos ajustes definen hacia que rama de Bubble apunta el operador local.</p>
        </div>
        <button type="button" data-cloud-sync-refresh ${state.operatorCloudLoading ? 'disabled' : ''}>
          ${state.operatorCloudLoading ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>
      ${state.operatorCloudError ? `<div class="service-warning">${escapeHtml(state.operatorCloudError)}</div>` : ''}
      <form class="anpr-config-form" id="cloudSyncForm">
        <div class="anpr-config-grid">
          <label>
            Rama
            <select name="branchPreset" data-cloud-branch-preset>
              <option value="live" ${preset === 'live' ? 'selected' : ''}>Produccion</option>
              <option value="test" ${preset === 'test' ? 'selected' : ''}>version-test</option>
              <option value="13i8l" ${preset === '13i8l' ? 'selected' : ''}>bridge-dev</option>
              <option value="73hi5" ${preset === '73hi5' ? 'selected' : ''}>acc-upd</option>
              <option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom</option>
            </select>
          </label>
          <label data-cloud-custom-branch ${preset === 'custom' ? '' : 'hidden'}>
            Rama custom
            <input name="branchCustom" value="${preset === 'custom' ? escapeAttr(version) : ''}" placeholder="version-test" autocomplete="off" />
          </label>
          <label class="wide-field">
            URL base
            <input name="appBaseUrl" value="${escapeAttr(cfg.appBaseUrl || 'https://eolo.app')}" placeholder="https://eolo.app" />
          </label>
          <label class="toggle-field">
            <input name="deviceHeartbeatEnabled" type="checkbox" ${cfg.deviceHeartbeatEnabled !== false ? 'checked' : ''} />
            <span>Actualizar comunicacion del dispositivo en Cloud</span>
          </label>
        </div>
        ${renderDefinitionList([
          { label: 'Workflow base', value: cfg.workflowBaseUrl || 'Sin consultar' },
          { label: 'Heartbeat workflow', value: cfg.deviceHeartbeatWorkflowUrl || 'Sin consultar' },
          { label: 'Tipo de dato dispositivo', value: cfg.deviceDataType || 'dispositivosacceso' },
          { label: 'Identificador Bridge', value: cfg.effectiveDeviceId || cfg.deviceId || 'Sin consultar' },
          { label: 'SN Bridge', value: cfg.serialNumber || '-' }
        ])}
        ${state.operatorCloudMessage ? `<p class="form-message ok">${escapeHtml(state.operatorCloudMessage)}</p>` : ''}
        <div class="form-actions">
          <button type="submit" class="primary-button">Guardar</button>
        </div>
      </form>
    </section>
  `;
}

function renderSyncPermissionsTab() {
  const access = pedestrianAccessContext();
  const permissions = filterSyncPermissions(state.syncPermissions.length ? state.syncPermissions : state.pedestrianPermissions);
  const page = paginateSyncPermissions(permissions);
  const summary = summarizeOperatorSyncPermissions(state.syncPermissions.length ? state.syncPermissions : state.pedestrianPermissions);
  const cloud = state.health?.eoloUserSync?.cloud || {};
  const downloadedAt = state.syncPermissionsDownloadedAt || cloud.lastRunAt || 'Sin descarga';
  return `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Permisos</h4>
          <p>${access.id ? `Acceso activo: ${escapeHtml(access.name || access.id)}` : 'Selecciona un acceso en Operador para descargar permisos.'}</p>
        </div>
        <button type="button" data-sync-permissions-download ${state.syncPermissionsLoading || !access.id ? 'disabled' : ''}>
          ${state.syncPermissionsLoading ? 'Descargando...' : 'Descargar permisos'}
        </button>
      </div>
      ${state.syncPermissionsError ? `<div class="service-warning">${escapeHtml(state.syncPermissionsError)}</div>` : ''}
      ${renderDefinitionList([
        { label: 'Ultima descarga permisos', value: downloadedAt },
        { label: 'Vigentes despues de', value: state.syncPermissionsValidAfter || 'Sin corte' },
        { label: 'Origen tabla', value: state.syncPermissionsSource || 'Sin consultar' },
        { label: 'Total permisos vigentes', value: summary.total },
        { label: 'Consultados Cloud', value: state.syncPermissionsSourceCount || summary.total },
        { label: 'Vencidos omitidos', value: state.syncPermissionsSkippedExpired || 0 },
        { label: 'Personas/peatones', value: summary.pedestrians },
        { label: 'Vehiculos', value: summary.vehicles },
        { label: 'Con rostro', value: summary.faces }
      ])}
      ${renderSyncPermissionToolbar(permissions.length)}
      ${renderSyncPermissionsTable(page.items)}
      ${renderSyncPermissionPagination(page)}
    </section>
  `;
}

function renderSyncDevicesTab() {
  const eolo = state.deviceConfig?.eolo || {};
  const sync = state.health?.eoloUserSync || {};
  const deviceSync = sync.device || {};
  const cloud = sync.cloud || {};
  const eligible = sync.eligibleFaceDevices ?? state.faceDevices.filter((device) => device.enabled && device.lastTestOk).length;
  const total = sync.totalFaceDevices ?? state.faceDevices.length;
  const hasSavedToken = Boolean(eolo.tokenSet);
  const hasOperatorToken = Boolean(localStorage.getItem('eolo.operator.token'));
  const status = sync.processing || deviceSync.running
    ? 'procesando'
    : sync.lastError || deviceSync.lastError
      ? 'error'
      : deviceSync.lastResult
        ? 'exito'
        : 'pendiente';
  return `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Dispositivos</h4>
          <p>Configura la carga automatica del snapshot de permisos hacia lectores faciales probados.</p>
        </div>
        ${renderStateLed(sync.enabled, sync.enabled ? 'Auto activa' : 'Auto inactiva')}
      </div>
      ${state.syncDeviceError ? `<div class="service-warning">${escapeHtml(state.syncDeviceError)}</div>` : ''}
      ${state.syncDeviceMessage ? `<p class="form-message ok">${escapeHtml(state.syncDeviceMessage)}</p>` : ''}
      ${renderDefinitionList([
        { label: 'Estado', value: status },
        { label: 'Ultima descarga snapshot', value: cloud.lastRunAt || 'Sin ejecucion' },
        { label: 'Ultima carga dispositivos', value: deviceSync.lastRunAt || 'Sin ejecucion' },
        { label: 'Dispositivos elegibles', value: `${eligible}/${total}` },
        { label: 'Token automatico', value: sync.scheduledTokenSet ? 'Sesion operador activa' : hasSavedToken ? 'Guardado para manual' : hasOperatorToken ? 'Sesion navegador' : 'Pendiente' },
        { label: 'Error', value: sync.lastError || cloud.lastError || deviceSync.lastError || '-' }
      ])}
      <form class="anpr-config-form" id="syncDeviceForm">
        <div class="anpr-config-grid">
          <label class="toggle-field">
            <input name="userSyncEnabled" type="checkbox" ${eolo.userSyncEnabled ? 'checked' : ''} />
            <span>Sincronizar automaticamente permisos a dispositivos</span>
          </label>
          <label>
            ID Acceso EOLO
            <input name="access" value="${escapeAttr(eolo.access || pedestrianAccessContext().id || '')}" placeholder="1754678396045x..." />
          </label>
          <label>
            Intervalo automatico min.
            <input name="intervalMinutes" type="number" min="1" max="1440" value="${escapeAttr(eolo.userSyncIntervalMinutes || sync.intervalMinutes || 30)}" />
          </label>
          <input name="endpoint" type="hidden" value="${escapeAttr(eolo.userSyncEndpoint || sync.endpoint || 'permisos-acceso')}" />
          <label class="toggle-field">
            <input name="changeToken" type="checkbox" ${hasSavedToken ? '' : 'checked'} ${hasSavedToken ? '' : 'disabled'} />
            <span>Cambiar token guardado</span>
          </label>
          <label class="wide-field">
            Token Bearer EOLO
            <input name="token" type="password" autocomplete="off" placeholder="${hasSavedToken ? 'Token guardado; activa cambiar para reemplazarlo' : hasOperatorToken ? 'Opcional; se usara la sesion del operador' : 'Token Bearer para sincronizacion'}" ${hasSavedToken ? 'disabled' : ''} />
          </label>
        </div>
        <div class="form-actions">
          <button type="submit" class="primary-button">Guardar</button>
          <button type="button" data-download-cloud-users>Crear snapshot ahora</button>
          <button type="button" data-apply-device-users>Cargar a dispositivos probados</button>
          <button type="button" data-run-users-sync>Sincronizar y cargar</button>
        </div>
      </form>
      <pre class="json-block face-sync-log">${escapeHtml(pretty(sync.lastResult || cloud.lastResult || deviceSync.lastResult || {}))}</pre>
    </section>
  `;
}

function renderLogsServiceView() {
  const selected = findSettingsLog(state.selectedSettingsLogId);
  if (selected) return renderSettingsLogDetail(selected);
  const logs = settingsLogsNewestFirst();
  const summary = summarizeSettingsLogs(logs);
  return `
    <section class="pedestrians-hero-card">
      <div>
        <h3>Logs</h3>
        <p>Consulta la actividad local del Bridge, sincronizaciones, comunicaciones con dispositivos y respuestas de EOLO Cloud.</p>
      </div>
      <span class="stream-led-pill ${summary.errors || summary.warns ? '' : 'active'}">
        <i aria-hidden="true"></i>
        ${escapeHtml(summary.lastLabel)}
      </span>
    </section>
    ${renderMetrics([
      { label: 'Registros', value: logs.length },
      { label: 'Errores', value: summary.errors },
      { label: 'Warnings', value: summary.warns },
      { label: 'Info', value: summary.info }
    ])}
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact">
        <div>
          <h4>Actividad reciente</h4>
          <p>Mostrando hasta 500 registros locales, ordenados del mas nuevo al mas antiguo.</p>
        </div>
        <button type="button" data-settings-logs-refresh ${state.settingsLogsLoading ? 'disabled' : ''}>
          ${state.settingsLogsLoading ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>
      ${state.settingsLogsError ? `<div class="service-warning">${escapeHtml(state.settingsLogsError)}</div>` : ''}
      ${renderSettingsLogsTable(logs)}
    </section>
  `;
}

function renderSettingsLogsTable(logs = []) {
  if (!logs.length) return '<div class="empty-state compact">Sin logs todavia.</div>';
  return `
    <div class="service-table-wrap logs-table-wrap">
      <table class="service-table settings-logs-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Nivel</th>
            <th>Origen</th>
            <th>Mensaje</th>
            <th>Info</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((record) => {
            const id = logDomId(record);
            return `
              <tr class="settings-log-row ${escapeAttr(record.level || 'info')}" id="settings-${escapeAttr(id)}" data-settings-log-id="${escapeAttr(id)}">
                <td>${escapeHtml(formatLogDate(record.ts))}</td>
                <td><span class="log-level-pill ${escapeAttr(record.level || 'info')}">${escapeHtml(String(record.level || 'info').toUpperCase())}</span></td>
                <td>${escapeHtml(logSource(record))}</td>
                <td><strong>${escapeHtml(formatLogMessage(record))}</strong></td>
                <td>${escapeHtml(logMetaSummary(record))}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSettingsLogDetail(record = {}) {
  const level = String(record.level || 'info').toUpperCase();
  return `
    <section class="service-section wide pedestrians-section">
      <div class="service-section-heading compact device-editor-heading">
        <button type="button" class="icon-button chevron-back-button" data-settings-log-back aria-label="Regresar a logs">
          <span aria-hidden="true">‹</span>
        </button>
        <div class="device-editor-title">
          <h4>${escapeHtml(formatLogMessage(record))}</h4>
          <p>${escapeHtml(formatLogDate(record.ts))}</p>
        </div>
        <span class="log-level-pill ${escapeAttr(record.level || 'info')}">${escapeHtml(level)}</span>
      </div>
      ${renderDefinitionList([
        { label: 'Timestamp', value: record.ts || '-' },
        { label: 'Nivel', value: level },
        { label: 'Origen', value: logSource(record) },
        { label: 'Mensaje', value: record.message || '-' },
        { label: 'Metadatos', value: logMetaSummary(record) }
      ])}
      <div class="settings-log-detail-grid">
        <section>
          <h4>Log completo</h4>
          <pre class="json-block settings-log-json">${escapeHtml(pretty(record))}</pre>
        </section>
        <section>
          <h4>Meta</h4>
          <pre class="json-block settings-log-json">${escapeHtml(pretty(record.meta || {}))}</pre>
        </section>
      </div>
    </section>
  `;
}

function settingsLogsNewestFirst() {
  return [...state.logs]
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
}

function normalizeLogsChronological(logs = []) {
  return [...logs]
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0));
}

function findSettingsLog(id = '') {
  if (!id) return null;
  return state.logs.find((record) => logDomId(record) === id) || null;
}

function summarizeSettingsLogs(logs = []) {
  const errors = logs.filter((record) => record.level === 'error').length;
  const warns = logs.filter((record) => record.level === 'warn').length;
  const info = logs.filter((record) => !['error', 'warn'].includes(record.level)).length;
  const latest = logs[0];
  return {
    errors,
    warns,
    info,
    lastLabel: latest ? `${formatLogDate(latest.ts)} · ${String(latest.level || 'info').toUpperCase()}` : 'Sin logs'
  };
}

function formatLogDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function logMetaSummary(record = {}) {
  const meta = record.meta || {};
  if (!meta || typeof meta !== 'object' || !Object.keys(meta).length) return '-';
  if (meta.error) return `error: ${meta.error}`;
  if (meta.status) return `status: ${meta.status}`;
  if (meta.serviceId) return `serviceId: ${meta.serviceId}`;
  if (meta.accessId) return `accessId: ${meta.accessId}`;
  return Object.keys(meta).slice(0, 4).join(', ');
}

function syncIdentificationReaderControls() {
  const form = $('#identificationReaderForm');
  if (!form) return;
  const cfg = state.operatorIdentificationConfig || {};
  const hasSavedKey = Boolean(cfg.apiKeySet);
  const changingKey = !hasSavedKey || form.elements.changeApiKey.checked;
  form.elements.changeApiKey.disabled = !hasSavedKey;
  form.elements.apiKey.disabled = !changingKey;
  form.elements.apiKey.required = form.elements.enabled.checked && changingKey;
  form.elements.model.required = form.elements.enabled.checked;
  form.elements.apiKey.placeholder = changingKey
    ? 'API key de OpenAI'
    : 'API key guardada; activa cambiar para reemplazarla';
}

function syncCloudSyncControls() {
  const form = $('#cloudSyncForm');
  if (!form) return;
  const isCustom = form.elements.branchPreset.value === 'custom';
  const label = form.querySelector('[data-cloud-custom-branch]');
  if (label) label.hidden = !isCustom;
  form.elements.branchCustom.disabled = !isCustom;
  form.elements.branchCustom.required = isCustom;
}

function syncSyncDeviceControls() {
  const form = $('#syncDeviceForm');
  if (!form) return;
  const hasSavedToken = Boolean(state.deviceConfig?.eolo?.tokenSet);
  const hasOperatorToken = Boolean(localStorage.getItem('eolo.operator.token'));
  const changingToken = !hasSavedToken || form.elements.changeToken.checked;
  const syncEnabled = form.elements.userSyncEnabled.checked;
  form.elements.access.required = syncEnabled;
  form.elements.endpoint.required = syncEnabled;
  form.elements.token.disabled = !changingToken;
  form.elements.token.required = syncEnabled && changingToken && !hasOperatorToken;
  form.elements.token.placeholder = changingToken
    ? hasOperatorToken
      ? 'Opcional; se usara la sesion del operador'
      : 'Token Bearer de EOLO'
    : 'Token guardado; activa cambiar para reemplazarlo';
}

function renderCameraHardwareEditor(hardware = anprHardware()) {
  const cameras = hardware.cameras?.length ? hardware.cameras : [emptyCamera()];
  return `
    <form class="hardware-form" id="anprHardwareForm">
      <div class="hardware-editor-block">
        <div class="hardware-editor-header">
          <strong>Cámaras RTSP</strong>
          <button type="button" data-add-camera>Agregar cámara</button>
        </div>
        <div class="hardware-list" id="hardwareCameraRows">
          ${cameras.map((camera, index) => renderCameraEditorRow(camera, index, hardware.barriers || [])).join('')}
        </div>
      </div>
      <div class="form-actions">
        <button type="submit">Guardar cámaras</button>
      </div>
    </form>
  `;
}

function renderBarrierHardwareEditor(hardware = anprHardware()) {
  const barriers = hardware.barriers?.length ? hardware.barriers : [emptyBarrier()];
  return `
    <form class="hardware-form" id="anprHardwareForm">
      <div class="hardware-editor-block">
        <div class="hardware-editor-header">
          <strong>Barreras ISAPI</strong>
          <button type="button" data-add-barrier>Agregar barrera</button>
        </div>
        <div class="hardware-list" id="hardwareBarrierRows">
          ${barriers.map((barrier, index) => renderBarrierEditorRow(barrier, index)).join('')}
        </div>
      </div>
      <div class="form-actions">
        <button type="submit">Guardar barreras</button>
      </div>
    </form>
  `;
}

function emptyCamera() {
  return { name: '', rtsp: '', type: 'Entrada', prefix: '', barrier_ids: [] };
}

function emptyBarrier() {
  return { id_barra: '', numero_barra: '', ip_puerto: '', usuario: '', password: '', camera_name: '' };
}

function renderCameraEditorRow(camera = emptyCamera(), index = 0, barriers = []) {
  const linkedIds = new Set(camera.barrier_ids || []);
  return `
    <div class="hardware-row camera-row" data-camera-row>
      <label>
        Nombre / ubicacion
        <input name="camera_name_${index}" value="${escapeHtml(camera.name || '')}" placeholder="Entrada Principal" />
      </label>
      <label class="wide-field">
        RTSP URL
        <input name="camera_rtsp_${index}" value="${escapeHtml(camera.rtsp || camera.rtsp_url || '')}" placeholder="rtsp://usuario:pass@ip:puerto/path" />
      </label>
      <label>
        Tipo
        <select name="camera_type_${index}">
          <option value="Entrada" ${camera.type === 'Entrada' ? 'selected' : ''}>Entrada</option>
          <option value="Salida" ${camera.type === 'Salida' ? 'selected' : ''}>Salida</option>
        </select>
      </label>
      <label>
        Prefijo
        <input name="camera_prefix_${index}" value="${escapeHtml(camera.prefix || '')}" maxlength="3" placeholder="ENT" />
      </label>
      <div class="wide-field barrier-picker">
        <span>Barreras asociadas</span>
        <div class="barrier-checkboxes">
          ${barriers.length
            ? barriers
                .map((barrier) => {
                  const id = barrier.id_barra || '';
                  const label = barrier.numero_barra ? `${barrier.numero_barra} - ${id}` : id;
                  return `
                    <label class="barrier-checkbox">
                      <input type="checkbox" data-camera-barrier-id="${escapeHtml(id)}" ${linkedIds.has(id) ? 'checked' : ''} />
                      <span>${escapeHtml(label || 'Sin ID')}</span>
                    </label>
                  `;
                })
                .join('')
            : '<span class="muted-inline">Registra barreras para vincularlas.</span>'}
        </div>
      </div>
      <button type="button" class="danger" data-remove-hardware-row>Eliminar</button>
    </div>
  `;
}

function renderBarrierEditorRow(barrier = emptyBarrier(), index = 0) {
  return `
    <div class="hardware-row barrier-row" data-barrier-row>
      <label>
        ID Barra
        <input name="barrier_id_${index}" value="${escapeHtml(barrier.id_barra || '')}" placeholder="barra-entrada" />
      </label>
      <label>
        Numero
        <input name="barrier_number_${index}" value="${escapeHtml(barrier.numero_barra || '')}" placeholder="1" />
      </label>
      <label>
        IP y puerto
        <input name="barrier_ip_${index}" value="${escapeHtml(barrier.ip_puerto || '')}" placeholder="192.168.1.10:80" />
      </label>
      <label>
        Usuario
        <input name="barrier_user_${index}" value="${escapeHtml(barrier.usuario || '')}" placeholder="admin" />
      </label>
      <label>
        Contrasena
        <input name="barrier_password_${index}" type="password" value="${escapeHtml(barrier.password || '')}" />
      </label>
      <button type="button" class="danger" data-remove-hardware-row>Eliminar</button>
    </div>
  `;
}

function renderVisitSyncServiceView() {
  const access = dashboard().access || {};
  return `
    ${renderAnprUnavailable()}
    ${renderMetrics([
      { label: 'Servicio', value: serviceIsRunning('visit-sync') ? 'Activo' : 'Detenido' },
      { label: 'Mov. pendientes', value: access.pending_sync_count ?? '-' },
      { label: 'Placas residentes', value: access.plate_count ?? '-' },
      { label: 'Accesos recientes', value: (access.movements || []).length }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>Sincronizacion</h4>
        ${renderServiceActions('visit-sync', {
          extra: '<button type="button" data-run-visit-sync>Sincronizar ahora</button>'
        })}
      </section>
      <section class="service-section">
        <h4>Placas base</h4>
        ${renderTable(
          [
            { label: 'Placa', value: 'placa' },
            { label: 'Nombre', value: 'nombre' },
            { label: 'Telefono', value: 'telefono' }
          ],
          access.plates || [],
          'Sin placas residentes cargadas.'
        )}
      </section>
      <section class="service-section wide">
        <h4>Accesos recientes</h4>
        ${renderAccessMovementsTable(access.movements || [])}
      </section>
    </div>
  `;
}

function renderAccessMovementsTable(rows) {
  return renderTable(
    [
      { label: 'Folio', value: 'folio' },
      { label: 'Placa', value: 'placa' },
      { label: 'Entrada', value: 'fecha_entrada' },
      { label: 'Salida', value: 'fecha_salida' },
      { label: 'Cam. entrada', value: 'camara_entrada' },
      { label: 'Cam. salida', value: 'camara_salida' },
      { label: 'Sync', value: 'sync', type: 'sync' }
    ],
    rows,
    'Sin movimientos de acceso.'
  );
}

function renderEmptyServiceView() {
  return '<div class="empty-state compact">Selecciona un servicio para ver su proceso.</div>';
}

async function submitEmployee(form, action) {
  const data = Object.fromEntries(new FormData(form).entries());
  const method = action === 'create' ? 'POST' : action === 'update' ? 'PUT' : 'DELETE';
  const path =
    action === 'create' ? '/api/employees' : `/api/employees/${encodeURIComponent(data.employeeNo)}`;
  const result = await api(path, {
    method,
    headers: action === 'delete' ? undefined : { 'Content-Type': 'application/json' },
    body: action === 'delete' ? undefined : JSON.stringify(data)
  });
  addMessage('assistant', `Operacion ${action} completada para ${data.employeeNo}.`, result);
  await loadEmployees(state.employeePage.filter, state.employeePage.page).catch(() => {});
}

async function submitFace(form) {
  const formData = new FormData(form);
  const employeeNo = formData.get('employeeNo');
  const result = await api(`/api/employees/${encodeURIComponent(employeeNo)}/face`, {
    method: 'POST',
    body: formData
  });
  addMessage('assistant', `Rostro cargado para ${employeeNo}.`, result);
}

async function loadEmployees(employeeNo = state.employeePage.filter, page = state.employeePage.page) {
  const normalizedPage = Math.max(0, Number(page) || 0);
  state.employeePage.filter = employeeNo;
  state.employeePage.page = normalizedPage;
  const query = new URLSearchParams({
    limit: String(state.employeePage.pageSize),
    position: String(normalizedPage * state.employeePage.pageSize)
  });
  if (employeeNo) query.set('employeeNo', employeeNo);
  const result = await api(`/api/employees?${query.toString()}`);
  state.employees = result.employees || [];
  state.employeePage.total = Number(result.totalMatches || state.employees.length || 0);
  state.employeeDirectoryLoaded = true;
  renderEmployees(result);
  return result;
}

function renderEmployees(result = {}) {
  const container = $('#employeeTable');
  if (!container) return;
  if (!state.employees.length) {
    container.innerHTML = `
      <div class="empty-state">Sin empleados encontrados.</div>
      ${renderEmployeePagination(result)}
    `;
    return;
  }
  container.innerHTML = `
    <div class="employee-table-head">
      <span>ID</span>
      <span>Nombre</span>
      <span>Puerta / Plan</span>
      <span>Acciones</span>
    </div>
    ${state.employees
      .map((employee) => {
        const rightPlan = Array.isArray(employee.RightPlan) ? employee.RightPlan[0] : {};
        const doorNo = rightPlan?.doorNo || employee.doorNo || employee.doorRight || '-';
        const planTemplateNo = rightPlan?.planTemplateNo || employee.planTemplateNo || '-';
        return `
          <article class="employee-row" data-employee-no="${escapeHtml(employee.employeeNo || employee.employeeNoString || '')}">
            <span class="employee-id">${escapeHtml(employee.employeeNo || employee.employeeNoString || '-')}</span>
            <strong>${escapeHtml(employee.name || '-')}</strong>
            <span>${escapeHtml(doorNo)} / ${escapeHtml(planTemplateNo)}</span>
            <div class="row-actions">
              <button type="button" data-edit-employee="${escapeHtml(employee.employeeNo || employee.employeeNoString || '')}">Editar</button>
              <button type="button" class="danger" data-delete-employee="${escapeHtml(employee.employeeNo || employee.employeeNoString || '')}">Eliminar</button>
            </div>
          </article>
        `;
      })
      .join('')}
    ${renderEmployeePagination(result)}
  `;
}

function renderEmployeePagination(result = {}) {
  const total = Number(result.totalMatches || state.employeePage.total || state.employees.length || 0);
  const pageSize = state.employeePage.pageSize;
  const page = state.employeePage.page;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize + state.employees.length);
  const prevDisabled = page <= 0 ? 'disabled' : '';
  const nextDisabled = page >= pageCount - 1 ? 'disabled' : '';
  return `
    <div class="employee-pagination">
      <p class="table-foot">${escapeHtml(from)}-${escapeHtml(to)} de ${escapeHtml(total)} empleados · pagina ${escapeHtml(page + 1)} de ${escapeHtml(pageCount)}</p>
      <div class="pagination-actions">
        <button type="button" data-employee-page="prev" ${prevDisabled}>Anterior</button>
        <button type="button" data-employee-page="next" ${nextDisabled}>Siguiente</button>
      </div>
    </div>
  `;
}

function employeeByNo(employeeNo) {
  return state.employees.find(
    (employee) => String(employee.employeeNo || employee.employeeNoString) === String(employeeNo)
  );
}

function openEditEmployee(employeeNo) {
  const employee = employeeByNo(employeeNo);
  if (!employee) return;
  const form = $('#editEmployeeForm');
  const faceForm = $('#editEmployeeFaceForm');
  const rightPlan = Array.isArray(employee.RightPlan) ? employee.RightPlan[0] : {};
  const id = employee.employeeNo || employee.employeeNoString;
  form.elements.employeeNo.value = id;
  form.elements.name.value = employee.name || '';
  form.elements.doorNo.value = rightPlan?.doorNo || employee.doorNo || state.deviceConfig?.hikvision?.doorNo || 1;
  form.elements.planTemplateNo.value =
    rightPlan?.planTemplateNo || employee.planTemplateNo || state.deviceConfig?.hikvision?.planTemplateNo || '1';
  faceForm.reset();
  faceForm.elements.employeeNo.value = id;
  setEditTab('details');
  $('#editEmployeeModal').showModal();
}

function openDeleteEmployee(employeeNo) {
  const employee = employeeByNo(employeeNo);
  const form = $('#deleteEmployeeForm');
  form.elements.employeeNo.value = employeeNo;
  $('#deleteEmployeeText').textContent = `Confirma la baja de ${employee?.name || 'este empleado'} (${employeeNo}).`;
  $('#deleteEmployeeModal').showModal();
}

async function submitEditEmployee(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const result = await api(`/api/employees/${encodeURIComponent(data.employeeNo)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  $('#editEmployeeModal').close();
  addMessage('assistant', `Empleado ${data.employeeNo} modificado.`, result);
  await loadEmployees($('#employeeSearchInput').value.trim(), state.employeePage.page).catch(() => {});
}

async function submitEditEmployeeFace(form) {
  const formData = new FormData(form);
  const employeeNo = formData.get('employeeNo');
  const result = await api(`/api/employees/${encodeURIComponent(employeeNo)}/face`, {
    method: 'POST',
    body: formData
  });
  addMessage('assistant', `Rostro actualizado para ${employeeNo}.`, result);
  form.reset();
  form.elements.employeeNo.value = employeeNo;
  await loadEmployees($('#employeeSearchInput').value.trim(), state.employeePage.page).catch(() => {});
}

async function submitDeleteEmployee(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const result = await api(`/api/employees/${encodeURIComponent(data.employeeNo)}`, {
    method: 'DELETE'
  });
  $('#deleteEmployeeModal').close();
  addMessage('assistant', `Empleado ${data.employeeNo} eliminado.`, result);
  await loadEmployees($('#employeeSearchInput').value.trim(), state.employeePage.page).catch(() => {});
}

function fillDeviceConfigForm(payload) {
  const form = $('#deviceConfigForm');
  if (!form || !payload) return;
  const device = payload.hikvision;
  const dahua = payload.dahua || {};
  const eolo = payload.eolo || {};
  const hasSavedPassword = Boolean(device.passwordSet);
  const hasSavedDahuaPassword = Boolean(dahua.passwordSet);
  const hasSavedEoloToken = Boolean(eolo.tokenSet);
  if (!state.faceDeviceTabTouched) {
    state.activeFaceDeviceTab = payload.faceDevice || state.activeFaceDeviceTab || 'hikvision';
  }
  form.elements.mockDevice.checked = Boolean(payload.mockDevice);
  form.elements.protocol.value = device.protocol || 'http';
  form.elements.port.value = device.port || 80;
  form.elements.bridgeIdentifier.value = device.bridgeIdentifier || 'Nuevo Dispositivo Bridge';
  form.elements.localDeviceId.value = device.localDeviceId || '';
  form.elements.host.value = device.host || '';
  form.elements.username.value = device.username || '';
  form.elements.password.value = '';
  form.elements.changePassword.checked = !hasSavedPassword;
  form.elements.changePassword.disabled = !hasSavedPassword;
  syncPasswordControls();
  form.elements.eoloUserSyncEnabled.checked = Boolean(eolo.userSyncEnabled);
  form.elements.eoloUserSyncEndpoint.value = eolo.userSyncEndpoint || 'permisos-acceso';
  form.elements.eoloAccess.value = eolo.access || '';
  form.elements.eoloUserSyncIntervalMinutes.value = eolo.userSyncIntervalMinutes || 30;
  form.elements.eoloToken.value = '';
  form.elements.changeEoloToken.checked = !hasSavedEoloToken;
  form.elements.changeEoloToken.disabled = !hasSavedEoloToken;
  syncEoloTokenControls();
  form.elements.doorNo.value = device.doorNo || 1;
  form.elements.planTemplateNo.value = device.planTemplateNo || '1';
  form.elements.fdid.value = device.fdid || '1';
  form.elements.faceLibType.value = device.faceLibType || 'blackFD';
  form.elements.dedupWindowSeconds.value = device.dedupWindowSeconds || 8;
  form.elements.dahuaProtocol.value = dahua.protocol || 'http';
  form.elements.dahuaPort.value = dahua.port || 80;
  form.elements.dahuaBridgeIdentifier.value = dahua.bridgeIdentifier || 'Dahua ASI';
  form.elements.dahuaLocalDeviceId.value = dahua.localDeviceId || '';
  form.elements.dahuaHost.value = dahua.host || '';
  form.elements.dahuaUsername.value = dahua.username || '';
  form.elements.dahuaPassword.value = '';
  form.elements.changeDahuaPassword.checked = !hasSavedDahuaPassword;
  form.elements.changeDahuaPassword.disabled = !hasSavedDahuaPassword;
  form.elements.dahuaDoorNo.value = dahua.doorNo ?? 0;
  form.elements.dahuaCardType.value = dahua.cardType ?? 0;
  form.elements.dahuaValidYears.value = dahua.validYears || 10;
  form.elements.dahuaDedupWindowSeconds.value = dahua.dedupWindowSeconds || 8;
  form.elements.dahuaEventCodes.value = dahua.eventCodes || 'All';
  form.elements.dahuaHeartbeatSeconds.value = dahua.heartbeatSeconds || 5;
  syncDahuaPasswordControls();
  syncFaceDeviceControls();

  const employeeForm = $('#employeeForm');
  if (employeeForm) {
    employeeForm.elements.doorNo.value = faceDeviceSettings(payload).doorNo ?? 1;
    employeeForm.elements.planTemplateNo.value = device.planTemplateNo || '1';
  }
}

function readDeviceConfigForm() {
  const form = $('#deviceConfigForm');
  const data = Object.fromEntries(new FormData(form).entries());
  const hasSavedPassword = Boolean(state.deviceConfig?.hikvision?.passwordSet);
  const shouldChangePassword = !hasSavedPassword || form.elements.changePassword.checked;
  const hasSavedDahuaPassword = Boolean(state.deviceConfig?.dahua?.passwordSet);
  const shouldChangeDahuaPassword = !hasSavedDahuaPassword || form.elements.changeDahuaPassword.checked;
  const hasSavedEoloToken = Boolean(state.deviceConfig?.eolo?.tokenSet);
  const shouldChangeEoloToken = !hasSavedEoloToken || form.elements.changeEoloToken.checked;
  return {
    mockDevice: form.elements.mockDevice.checked,
    faceDevice: state.activeFaceDeviceTab || state.deviceConfig?.faceDevice || 'hikvision',
    hikvision: {
      protocol: data.protocol,
      bridgeIdentifier: data.bridgeIdentifier,
      localDeviceId: data.localDeviceId,
      host: data.host,
      port: Number(data.port),
      username: data.username,
      password: shouldChangePassword ? form.elements.password.value : '',
      doorNo: Number(data.doorNo),
      planTemplateNo: data.planTemplateNo,
      fdid: data.fdid,
      faceLibType: data.faceLibType,
      dedupWindowSeconds: Number(data.dedupWindowSeconds)
    },
    dahua: {
      protocol: data.dahuaProtocol,
      bridgeIdentifier: data.dahuaBridgeIdentifier,
      localDeviceId: data.dahuaLocalDeviceId,
      host: data.dahuaHost,
      port: Number(data.dahuaPort),
      username: data.dahuaUsername,
      password: shouldChangeDahuaPassword ? form.elements.dahuaPassword.value : '',
      doorNo: Number(data.dahuaDoorNo),
      cardType: Number(data.dahuaCardType),
      validYears: Number(data.dahuaValidYears),
      dedupWindowSeconds: Number(data.dahuaDedupWindowSeconds),
      eventCodes: data.dahuaEventCodes,
      heartbeatSeconds: Number(data.dahuaHeartbeatSeconds)
    },
    eolo: {
      userSyncEnabled: form.elements.eoloUserSyncEnabled.checked,
      userSyncEndpoint: data.eoloUserSyncEndpoint,
      access: data.eoloAccess,
      userSyncIntervalMinutes: Number(data.eoloUserSyncIntervalMinutes),
      token: shouldChangeEoloToken ? form.elements.eoloToken.value : ''
    }
  };
}

function syncPasswordControls() {
  const form = $('#deviceConfigForm');
  if (!form) return;
  const hasSavedPassword = Boolean(state.deviceConfig?.hikvision?.passwordSet);
  const changingPassword = !hasSavedPassword || form.elements.changePassword.checked;
  form.elements.password.disabled = !changingPassword;
  form.elements.password.required = state.activeFaceDeviceTab === 'hikvision' && changingPassword;
  form.elements.password.placeholder = changingPassword
    ? 'Nueva contrasena del dispositivo'
    : 'Contrasena guardada; activa cambiar para reemplazarla';
  $('#credentialHint').textContent = hasSavedPassword
    ? 'La contrasena guardada se conserva si no activas el cambio.'
    : 'No hay contrasena guardada; captura una para comunicarte con el dispositivo.';
}

function syncDahuaPasswordControls() {
  const form = $('#deviceConfigForm');
  if (!form) return;
  const hasSavedPassword = Boolean(state.deviceConfig?.dahua?.passwordSet);
  const changingPassword = !hasSavedPassword || form.elements.changeDahuaPassword.checked;
  form.elements.dahuaPassword.disabled = !changingPassword;
  form.elements.dahuaPassword.required = state.activeFaceDeviceTab === 'dahua' && changingPassword;
  form.elements.dahuaPassword.placeholder = changingPassword
    ? 'Nueva contrasena Dahua'
    : 'Contrasena guardada; activa cambiar para reemplazarla';
  $('#dahuaCredentialHint').textContent = hasSavedPassword
    ? 'La contrasena Dahua guardada se conserva si no activas el cambio.'
    : 'No hay contrasena Dahua guardada; captura una para comunicarte con el ASI.';
}

function syncFaceDeviceControls() {
  const activeFromDom = $('#serviceDetail [data-face-device-tab].active')?.dataset.faceDeviceTab;
  const active = activeFromDom || state.activeFaceDeviceTab || 'hikvision';
  state.activeFaceDeviceTab = active;
  $$('[data-device-settings]').forEach((section) => {
    section.hidden = section.dataset.deviceSettings !== active;
  });
  $$('[data-face-device-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.faceDeviceTab === active);
  });
  const form = $('#deviceConfigForm');
  if (!form) return;
  ['host', 'username', 'password'].forEach((name) => {
    if (form.elements[name]) form.elements[name].required = active === 'hikvision' && name !== 'password';
  });
  ['dahuaHost', 'dahuaUsername'].forEach((name) => {
    if (form.elements[name]) form.elements[name].required = active === 'dahua';
  });
  syncPasswordControls();
  syncDahuaPasswordControls();
}

function syncEoloTokenControls() {
  const form = $('#deviceConfigForm');
  if (!form) return;
  const hasSavedToken = Boolean(state.deviceConfig?.eolo?.tokenSet);
  const hasOperatorToken = Boolean(localStorage.getItem('eolo.operator.token'));
  const changingToken = !hasSavedToken || form.elements.changeEoloToken.checked;
  const syncEnabled = form.elements.eoloUserSyncEnabled.checked;
  form.elements.eoloUserSyncEndpoint.required = syncEnabled;
  form.elements.eoloAccess.required = syncEnabled;
  form.elements.eoloToken.disabled = !changingToken;
  form.elements.eoloToken.required = syncEnabled && changingToken && !hasOperatorToken;
  form.elements.eoloToken.placeholder = changingToken
    ? hasOperatorToken
      ? 'Opcional; se usara la sesion del operador'
      : 'Token Bearer de EOLO'
    : 'Token guardado; activa cambiar para reemplazarlo';
  $('#eoloTokenHint').textContent = hasSavedToken
    ? 'El token guardado se conserva si no activas el cambio.'
    : hasOperatorToken
      ? 'No hay token guardado; se usara la sesion del operador logueado.'
      : 'No hay token guardado; captura uno antes de sincronizar.';
}

function showValidation(result) {
  const node = $('#validationResult');
  node.classList.remove('ok', 'fail');
  node.classList.add(result.ok ? 'ok' : 'fail');
  node.textContent = result.message || (result.ok ? 'Conexion valida.' : 'Conexion no valida.');
  $('#deviceInfo').textContent = pretty({
    health: state.health,
    config: state.deviceConfig,
    validation: result
  });
}

function showEoloSyncDebug(result) {
  const node = $('#eoloSyncResult');
  node.classList.remove('ok', 'fail');
  node.classList.add(result.ok ? 'ok' : 'fail');
  node.textContent = result.message || (result.ok ? 'Operacion EOLO completada.' : 'Operacion EOLO no valida.');
  $('#eoloSyncInfo').textContent = pretty(result);
}

async function testDeviceConfig() {
  const result = await api('/api/device-config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readDeviceConfigForm())
  });
  showValidation(result);
  addMessage('assistant', result.message, result);
}

function readManagedFaceDeviceForm() {
  const form = $('#managedFaceDeviceForm');
  const data = Object.fromEntries(new FormData(form).entries());
  const selected = selectedManagedFaceDevice();
  const controlPointName = controlPointNameForId(data.controlPointId, data.controlPointName);
  return {
    type: data.type,
    enabled: form.elements.enabled.checked,
    name: data.name,
    bridgeIdentifier: data.bridgeIdentifier,
    localDeviceId: '',
    controlPointId: data.controlPointId,
    controlPointName,
    protocol: data.protocol,
    host: data.host,
    port: Number(data.port),
    username: data.username,
    password: form.elements.password.value,
    doorNo: Number(data.doorNo),
    planTemplateNo: data.planTemplateNo || selected.planTemplateNo || '1',
    fdid: data.fdid || selected.fdid || '1',
    faceLibType: data.faceLibType || selected.faceLibType || 'blackFD',
    cardType: Number(data.cardType || selected.cardType || 0),
    validYears: Number(data.validYears || selected.validYears || 10),
    dedupWindowSeconds: Number(data.dedupWindowSeconds || selected.dedupWindowSeconds || 8),
    eventCodes: data.eventCodes || selected.eventCodes || 'All',
    heartbeatSeconds: Number(data.heartbeatSeconds || selected.heartbeatSeconds || 5)
  };
}

async function refreshFaceDevices() {
  const result = await api('/api/face-devices');
  setManagedFaceDevices(result.devices || []);
  renderServiceSidebar();
  renderServiceDetail();
  return result;
}

async function saveManagedFaceDevice() {
  const selected = selectedManagedFaceDevice();
  const payload = readManagedFaceDeviceForm();
  const path = selected.id === 'new'
    ? '/api/face-devices'
    : `/api/face-devices/${encodeURIComponent(selected.id)}`;
  const result = await api(path, {
    method: selected.id === 'new' ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  setManagedFaceDevices(result.devices || []);
  if (selected.id === 'new') {
    const created = state.faceDevices.find((device) => device.host === payload.host && device.name === payload.name);
    state.selectedManagedFaceDeviceId = created?.id || state.faceDevices.at(-1)?.id || '';
  }
  state.faceDeviceLastResult = { ok: true, message: 'Dispositivo facial guardado.', device: payload };
  renderServiceSidebar();
  renderServiceDetail();
  addMessage('assistant', 'Dispositivo facial guardado.', state.faceDeviceLastResult);
}

async function testManagedFaceDevice() {
  const selected = selectedManagedFaceDevice();
  const payload = readManagedFaceDeviceForm();
  const path = selected.id === 'new'
    ? '/api/device-config/test'
    : `/api/face-devices/${encodeURIComponent(selected.id)}/test`;
  const body = selected.id === 'new'
    ? { mockDevice: false, faceDevice: payload.type, [payload.type]: payload }
    : payload;
  const result = await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (result.devices && result.saved !== false) {
    setManagedFaceDevices(result.devices);
  }
  state.faceDeviceLastResult = result;
  const node = $('.face-device-result');
  if (node) node.textContent = pretty(result);
  if (result.saved !== false) {
    renderServiceSidebar();
    renderServiceDetail();
  }
  addMessage('assistant', result.message || 'Prueba de dispositivo facial completada.', result);
}

async function deleteManagedFaceDevice() {
  const selected = selectedManagedFaceDevice();
  if (selected.id === 'new') return;
  const result = await api(`/api/face-devices/${encodeURIComponent(selected.id)}`, {
    method: 'DELETE'
  });
  setManagedFaceDevices(result.devices || []);
  state.faceDeviceLastResult = { ok: true, message: 'Dispositivo facial eliminado.' };
  renderServiceSidebar();
  renderServiceDetail();
}

async function toggleManagedFaceDeviceStream(deviceId) {
  const selected = state.faceDevices.find((device) => device.id === deviceId);
  if (!selected) return;
  const action = selected.stream?.running ? 'stop' : 'start';
  const result = await api(`/api/face-devices/${encodeURIComponent(deviceId)}/stream/${action}`, {
    method: 'POST'
  });
  setManagedFaceDevices(result.devices || []);
  state.faceDeviceLastResult = result.result || result;
  renderServiceSidebar();
  renderServiceDetail();
}

async function syncManagedFaceDevice(deviceId) {
  const result = await api(`/api/face-devices/${encodeURIComponent(deviceId)}/sync-device`, {
    method: 'POST'
  });
  setManagedFaceDevices(result.devices || []);
  state.faceDeviceLastResult = result.result || result;
  renderServiceDetail();
  addMessage('assistant', 'Snapshot EOLO cargado al dispositivo facial.', result.result || result);
}

async function startEnabledFaceDevices() {
  const result = await api('/api/face-devices/streams/start-enabled', { method: 'POST' });
  setManagedFaceDevices(result.devices || []);
  state.faceDeviceLastResult = result;
  renderServiceSidebar();
  renderServiceDetail();
}

async function stopAllFaceDevices() {
  const result = await api('/api/face-devices/streams/stop-all', { method: 'POST' });
  setManagedFaceDevices(result.devices || []);
  state.faceDeviceLastResult = result;
  renderServiceSidebar();
  renderServiceDetail();
}

function updateManagedFaceDeviceTypeSections() {
  const form = $('#managedFaceDeviceForm');
  if (!form) return;
  const type = form.elements.type.value;
  $$('[data-managed-type-section]', form).forEach((section) => {
    section.hidden = section.dataset.managedTypeSection !== type;
  });
  form.elements.doorNo.min = type === 'dahua' ? '0' : '1';
}

function syncManagedFaceDeviceControlPointName() {
  const form = $('#managedFaceDeviceForm');
  if (!form) return;
  const controlPointId = form.elements.controlPointId?.value || '';
  const name = controlPointNameForId(controlPointId, '');
  if (form.elements.controlPointName) {
    form.elements.controlPointName.value = name;
  }
}

function activateFaceDeviceTab(deviceType) {
  if (!['hikvision', 'dahua'].includes(deviceType)) return;
  state.activeFaceDeviceTab = deviceType;
  state.faceDeviceTabTouched = true;
  syncFaceDeviceControls();
}

async function persistDeviceConfig() {
  const result = await api('/api/device-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readDeviceConfigForm())
  });
  state.deviceConfig = result.config;
  return result;
}

async function saveDeviceConfig() {
  const result = await persistDeviceConfig();
  showValidation(result.validation);
  addMessage('assistant', 'Configuracion del dispositivo guardada y probada.', result.validation);
  await refreshHealth();
}

async function saveEoloConfig() {
  const saveResult = await persistDeviceConfig();
  showEoloSyncDebug({
    ok: true,
    message: 'Configuracion de sincronizacion EOLO guardada.',
    eolo: saveResult.config?.eolo
  });
  addMessage('assistant', 'Configuracion EOLO guardada.', {
    ok: true,
    eolo: saveResult.config?.eolo
  });
  await refreshHealth();
}

async function runEoloUserSync() {
  const result = await api('/api/eolo/users-sync/run', {
    method: 'POST'
  });
  const message = formatEoloRunMessage(result);
  showEoloSyncDebug({ ok: true, message, result });
  addMessage('assistant', message, result);
  await refreshHealth();
  await loadEmployees(state.employeePage.filter, state.employeePage.page).catch(() => {});
  return result;
}

async function downloadEoloUsersFromCloud() {
  const access = pedestrianAccessContext();
  state.syncPermissionsLoading = true;
  state.syncPermissionsError = '';
  renderServiceDetail();
  try {
    const result = await api('/api/eolo/users-sync/cloud-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: access.id || state.deviceConfig?.eolo?.access || '' })
    });
    if (Array.isArray(result.permissions)) {
      applyOperatorAccessPermissionsResult(result, result.access || access.id || '');
      state.syncPermissions = result.permissions;
      state.syncPermissionsDownloadedAt = result.completedAt || '';
      state.syncPermissionsSource = result.sourceType || result.source || 'permisoaccesos';
      state.syncPermissionsValidAfter = result.validAfter || '';
      state.syncPermissionsSkippedExpired = Number(result.skippedExpired || 0);
      state.syncPermissionsSourceCount = Number(result.sourceCount || result.cloudCount || result.permissions.length);
    }
    const expired = Number(result.skippedExpired || 0);
    const message = `Descarga permisos: ${result.cloudCount || 0} vigentes, ${result.validCloudCount || 0} usuarios faciales para snapshot, ${result.skippedForDeviceCount || 0} omitidos para dispositivo${expired ? `, ${expired} vencidos omitidos` : ''}.`;
    showEoloSyncDebug({ ok: true, message, result });
    addMessage('assistant', message, result);
    await refreshSyncStatus();
    return result;
  } finally {
    state.syncPermissionsLoading = false;
    renderServiceDetail();
  }
}

async function applyEoloUsersToDevice() {
  const result = await api('/api/eolo/users-sync/device-apply', {
    method: 'POST'
  });
  const summary = aggregateDeviceSyncResult(result);
  const message = `Carga dispositivo: ${summary.successCount}/${summary.targetCount} dispositivos, ${summary.created.length} creados, ${summary.updated.length} actualizados, ${summary.deleted.length} borrados, ${summary.facesUpdated.length} rostros.`;
  showEoloSyncDebug({ ok: true, message, result });
  addMessage('assistant', message, result);
  await refreshSyncStatus();
  return result;
}

async function saveSyncDeviceSettings(form) {
  const eolo = state.deviceConfig?.eolo || {};
  const hasSavedToken = Boolean(eolo.tokenSet);
  const shouldChangeToken = !hasSavedToken || form.elements.changeToken.checked;
  const payload = {
    eolo: {
      userSyncEnabled: form.elements.userSyncEnabled.checked,
      userSyncEndpoint: form.elements.endpoint.value.trim() || 'permisos-acceso',
      access: form.elements.access.value.trim(),
      userSyncIntervalMinutes: Number(form.elements.intervalMinutes.value || 30),
      token: shouldChangeToken ? form.elements.token.value : ''
    }
  };
  const result = await api('/api/device-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.deviceConfig = result.config;
  state.syncDeviceError = '';
  state.syncDeviceMessage = 'Configuracion de sincronizacion a dispositivos guardada.';
  addMessage('assistant', 'Sincronizacion a dispositivos guardada.', {
    ok: true,
    eolo: result.config?.eolo
  });
  await refreshHealth();
  return result;
}

async function runEoloTaskPoll() {
  const result = await api('/api/eolo/tasks/poll', {
    method: 'POST'
  });
  addMessage('assistant', `Consulta de tareas EOLO completada: ${result.processed || 0} procesadas.`, result);
  await loadServices().catch(() => {});
  return result;
}

async function runVisitSyncNow() {
  const result = await api('/api/anpr/sync-now', {
    method: 'POST'
  });
  addMessage('assistant', 'Sincronizacion de visitas ANPR ejecutada.', result);
  await loadServices().catch(() => {});
  return result;
}

async function saveAnprHardware(form) {
  const payload = readAnprHardwareForm(form);
  const result = await api('/api/anpr/hardware', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.anprHardware = result;
  state.anprHardwareError = null;
  addMessage('assistant', 'Hardware ANPR guardado.', {
    ok: true,
    cameras: result.cameras?.length || 0,
    barriers: result.barriers?.length || 0
  });
  await loadServices().catch(() => {});
  return result;
}

async function saveVehicleCamera(form) {
  const camera = readVehicleCameraForm(form);
  if (!camera.name && !camera.rtsp) {
    throw new Error('Captura al menos nombre o RTSP de la camara.');
  }
  const existing = anprHardware();
  const cameras = [...vehicleCameras()];
  if (state.selectedVehicleCameraIndex === 'new' || !state.selectedVehicleCameraIndex) {
    cameras.push(camera);
  } else {
    const index = Number(state.selectedVehicleCameraIndex);
    if (!Number.isInteger(index) || index < 0 || index >= cameras.length) {
      throw new Error('La camara seleccionada ya no existe en la configuracion local.');
    }
    cameras[index] = camera;
  }
  const result = await api('/api/anpr/hardware', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cameras,
      barriers: existing.barriers || []
    })
  });
  state.anprHardware = result;
  state.anprHardwareError = null;
  state.selectedVehicleCameraIndex = '';
  state.vehicleCameraLastResult = {
    ok: true,
    cameras: result.cameras?.length || 0,
    barriers: result.barriers?.length || 0
  };
  addMessage('assistant', 'Camara ANPR guardada.', state.vehicleCameraLastResult);
  await loadServices().catch(() => {});
  return result;
}

async function saveBarrierDevice(form) {
  const barrier = readBarrierDeviceForm(form);
  if (!barrier.id_barra && !barrier.ip_puerto) {
    throw new Error('Captura al menos ID de barra o IP/puerto.');
  }
  const existing = anprHardware();
  const barriers = [...barrierDevices()];
  if (state.selectedBarrierIndex === 'new' || !state.selectedBarrierIndex) {
    barriers.push(barrier);
  } else {
    const index = Number(state.selectedBarrierIndex);
    if (!Number.isInteger(index) || index < 0 || index >= barriers.length) {
      throw new Error('La puerta o barrera seleccionada ya no existe en la configuracion local.');
    }
    barriers[index] = barrier;
  }
  const result = await api('/api/anpr/hardware', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cameras: existing.cameras?.length ? existing.cameras : vehicleCameras(),
      barriers
    })
  });
  state.anprHardware = result;
  state.anprHardwareError = null;
  state.selectedBarrierIndex = '';
  state.barrierLastResult = {
    ok: true,
    cameras: result.cameras?.length || 0,
    barriers: result.barriers?.length || 0
  };
  addMessage('assistant', 'Puerta o barrera guardada.', state.barrierLastResult);
  await loadServices().catch(() => {});
  return result;
}

async function saveAnprConfig(form) {
  const payload = readAnprConfigForm(form);
  const result = await api('/api/anpr/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  addMessage('assistant', 'Parametros ANPR guardados.', {
    ok: true,
    server_url: result.server_url,
    version: result.version,
    bubble_token_set: result.bubble_token_set
  });
  await loadServices().catch(() => {});
  return result;
}

async function saveIdentificationReaderSettings(form) {
  const hasSavedKey = Boolean(state.operatorIdentificationConfig?.apiKeySet);
  const shouldChangeKey = !hasSavedKey || form.elements.changeApiKey.checked;
  const cameraId = form.elements.cameraId.value;
  const payload = {
    enabled: form.elements.enabled.checked,
    model: form.elements.model.value.trim() || 'gpt-4o-mini',
    apiKey: shouldChangeKey ? form.elements.apiKey.value.trim() : ''
  };
  const result = await api('/api/operator/vision-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.operatorIdentificationConfig = result.openaiVision || {};
  state.selectedOperatorCameraId = cameraId;
  if (cameraId) localStorage.setItem('eolo.operator.cameraId', cameraId);
  else localStorage.removeItem('eolo.operator.cameraId');
  state.operatorIdentificationLoaded = true;
  state.operatorIdentificationMessage = 'Configuracion de lectura de identificaciones guardada.';
  renderServiceSidebar();
  renderServiceDetail();
  addMessage('assistant', 'Lectura de identificaciones guardada.', {
    ok: true,
    enabled: state.operatorIdentificationConfig.enabled,
    apiKeySet: state.operatorIdentificationConfig.apiKeySet,
    model: state.operatorIdentificationConfig.model,
    cameraSet: Boolean(cameraId)
  });
  return result;
}

async function saveCloudSyncSettings(form) {
  const previousBaseUrl = String(state.operatorCloudConfig?.appBaseUrl || '').trim();
  const previousVersion = normalizedBranchValue(state.operatorCloudConfig?.appVersion);
  const preset = form.elements.branchPreset.value;
  const appVersion = preset === 'custom' ? form.elements.branchCustom.value.trim() : preset;
  const payload = {
    appBaseUrl: form.elements.appBaseUrl.value.trim() || 'https://eolo.app',
    appVersion,
    deviceHeartbeatEnabled: form.elements.deviceHeartbeatEnabled.checked
  };
  const result = await api('/api/operator/cloud-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.operatorCloudConfig = result.operator || {};
  state.operatorCloudLoaded = true;
  const nextBaseUrl = String(state.operatorCloudConfig.appBaseUrl || payload.appBaseUrl || '').trim();
  const nextVersion = normalizedBranchValue(state.operatorCloudConfig.appVersion || appVersion);
  const branchChanged = previousBaseUrl && (previousBaseUrl !== nextBaseUrl || previousVersion !== nextVersion);
  state.operatorCloudMessage = branchChanged
    ? 'Configuracion guardada. Si cambiaste de rama, vuelve a iniciar sesion en Operador para renovar el token.'
    : 'Configuracion de sincronizacion Cloud guardada.';
  renderServiceSidebar();
  renderServiceDetail();
  addMessage('assistant', 'Sincronizacion Cloud guardada.', {
    ok: true,
    appBaseUrl: state.operatorCloudConfig.appBaseUrl,
    appVersion: state.operatorCloudConfig.appVersion,
    branchLabel: state.operatorCloudConfig.branchLabel,
    deviceHeartbeatEnabled: state.operatorCloudConfig.deviceHeartbeatEnabled
  });
  return result;
}

async function saveBridgeSettings(form) {
  const access = pedestrianAccessContext();
  const payload = {
    serialNumber: form.elements.serialNumber.value.trim(),
    accessId: access.id || ''
  };
  const result = await api('/api/operator/bridge-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.operatorBridgeConfig = result.operator || {};
  state.operatorCloudConfig = result.operator || state.operatorCloudConfig;
  state.operatorBridgeLoaded = true;
  state.operatorBridgeError = '';
  state.operatorBridgeMessage = result.deviceHeartbeat?.ok
    ? 'SN guardado y reflejado en EOLO Cloud.'
    : result.deviceHeartbeat?.error
      ? `SN guardado localmente; Cloud no confirmo: ${result.deviceHeartbeat.error}`
      : 'SN guardado localmente.';
  state.operatorBridgeLastResult = result;
  renderServiceSidebar();
  renderServiceDetail();
  addMessage('assistant', state.operatorBridgeMessage, {
    ok: true,
    deviceId: state.operatorBridgeConfig.effectiveDeviceId,
    serialNumber: state.operatorBridgeConfig.serialNumber,
    deviceHeartbeat: result.deviceHeartbeat
  });
  return result;
}

function readAnprConfigForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    server_url: String(data.server_url || '').trim(),
    version: data.version || 'test',
    id_acceso: String(data.id_acceso || '').trim(),
    min_plate_width_ratio: Number(data.min_plate_width_ratio || 0),
    min_plate_height_ratio: Number(data.min_plate_height_ratio || 0),
    min_vehicle_confidence: Number(data.min_vehicle_confidence || 0),
    strict_plate_validation: Boolean(data.strict_plate_validation),
    require_vehicle_detection: Boolean(data.require_vehicle_detection)
  };
  const token = String(data.bubble_token || '').trim();
  if (token) payload.bubble_token = token;
  return payload;
}

function readAnprHardwareForm(form) {
  const existing = anprHardware();
  const cameraRows = [...form.querySelectorAll('[data-camera-row]')];
  const barrierRows = [...form.querySelectorAll('[data-barrier-row]')];

  const cameras = (cameraRows.length ? cameraRows : [])
    .map((row) => ({
      name: row.querySelector('[name^="camera_name_"]')?.value.trim() || '',
      rtsp: row.querySelector('[name^="camera_rtsp_"]')?.value.trim() || '',
      type: row.querySelector('[name^="camera_type_"]')?.value || 'Entrada',
      prefix: row.querySelector('[name^="camera_prefix_"]')?.value.trim().toUpperCase() || '',
      barrier_ids: [...row.querySelectorAll('[data-camera-barrier-id]:checked')]
        .map((input) => input.dataset.cameraBarrierId)
        .filter(Boolean)
    }))
    .filter((camera) => camera.name || camera.rtsp);

  const barriers = (barrierRows.length ? barrierRows : [])
    .map((row) => ({
      type: row.querySelector('[name^="barrier_type_"]')?.value || 'hikvision-isapi',
      id_barra: row.querySelector('[name^="barrier_id_"]')?.value.trim() || '',
      numero_barra: row.querySelector('[name^="barrier_number_"]')?.value.trim() || '',
      ip_puerto: row.querySelector('[name^="barrier_ip_"]')?.value.trim() || '',
      usuario: row.querySelector('[name^="barrier_user_"]')?.value.trim() || '',
      password: row.querySelector('[name^="barrier_password_"]')?.value || '',
      camera_name: ''
    }))
    .filter((barrier) => barrier.id_barra);

  return {
    cameras: cameraRows.length ? cameras : existing.cameras || [],
    barriers: barrierRows.length ? barriers : existing.barriers || []
  };
}

function readVehicleCameraForm(form) {
  return {
    name: form.querySelector('[name="camera_name"]')?.value.trim() || '',
    rtsp: form.querySelector('[name="camera_rtsp"]')?.value.trim() || '',
    type: form.querySelector('[name="camera_type"]')?.value || 'Entrada',
    prefix: form.querySelector('[name="camera_prefix"]')?.value.trim().toUpperCase() || '',
    barrier_ids: [...form.querySelectorAll('[data-vehicle-camera-barrier-id]:checked')]
      .map((input) => input.dataset.vehicleCameraBarrierId)
      .filter(Boolean)
  };
}

function readBarrierDeviceForm(form) {
  const current = selectedBarrier() || {};
  const password = form.querySelector('[name="barrier_password"]')?.value || '';
  return {
    type: form.querySelector('[name="barrier_type"]')?.value || 'hikvision-isapi',
    id_barra: form.querySelector('[name="barrier_id"]')?.value.trim() || '',
    numero_barra: form.querySelector('[name="barrier_number"]')?.value.trim() || '',
    ip_puerto: form.querySelector('[name="barrier_ip"]')?.value.trim() || '',
    usuario: form.querySelector('[name="barrier_user"]')?.value.trim() || '',
    password: password || current.password || '',
    camera_name: current.camera_name || ''
  };
}

function formatEoloRunMessage(result = {}) {
  if (result.skipped) {
    return `Sincronizacion EOLO omitida: ${result.reason || 'ya hay una sincronizacion en curso'}.`;
  }
  const summary = aggregateDeviceSyncResult(result.device || result);
  return `Sincronizacion EOLO: ${summary.successCount}/${summary.targetCount} dispositivos, ${summary.created.length} creados, ${summary.updated.length} actualizados, ${summary.deleted.length} eliminados, ${summary.facesUpdated.length} rostros.`;
}

async function handleCommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  addMessage('user', trimmed);

  const [verb, employeeNo, ...rest] = trimmed.split(/\s+/);
  const name = rest.join(' ');

  if (['alta', 'crear', 'create'].includes(verb.toLowerCase())) {
    const result = await api('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo, name })
    });
    addMessage('assistant', `Alta completada para ${employeeNo}.`, result);
    return;
  }

  if (['modificar', 'actualizar', 'update'].includes(verb.toLowerCase())) {
    const result = await api(`/api/employees/${encodeURIComponent(employeeNo)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo, name })
    });
    addMessage('assistant', `Modificacion completada para ${employeeNo}.`, result);
    return;
  }

  if (['baja', 'eliminar', 'delete'].includes(verb.toLowerCase())) {
    const result = await api(`/api/employees/${encodeURIComponent(employeeNo)}`, {
      method: 'DELETE'
    });
    addMessage('assistant', `Baja completada para ${employeeNo}.`, result);
    return;
  }

  if (['evento', 'simular'].includes(verb.toLowerCase())) {
    const result = await api('/api/mock/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo, name })
    });
    addMessage('assistant', `Evento generado para ${employeeNo}.`, result);
    return;
  }

  if (['estado', 'health'].includes(verb.toLowerCase())) {
    await refreshHealth();
    addMessage('assistant', 'Estado actualizado.', state.health);
    return;
  }

  addMessage(
    'assistant',
    'Comando no reconocido. Usa alta 1001 Nombre, modificar 1001 Nombre, baja 1001 o evento 1001 Nombre.'
  );
}

function renderEvents() {
  if (!state.events.length) {
    eventList.innerHTML = '<div class="empty-state">Sin eventos recibidos todavia.</div>';
    return;
  }
  eventList.innerHTML = state.events
    .slice(-80)
    .reverse()
    .map((event) => {
      const badge = event.operationalDuplicate ? 'Duplicado' : `Subtipo ${event.subEventType || '-'}`;
      const raw = event.raw || event;
      return `
        <article class="event-row">
          <div>
            <strong>${escapeHtml(event.name || 'Sin nombre')}</strong>
            <span>${escapeHtml(event.employeeNo || 'Sin empleado')} · ${escapeHtml(event.currentVerifyMode || '-')}</span>
          </div>
          <div class="event-meta">
            <div>
              <em>${escapeHtml(badge)}</em>
              <small>#${escapeHtml(event.serialNo || '-')} ${escapeHtml(event.dateTime || event.receivedAt || '')}</small>
            </div>
          </div>
          <details class="raw-event">
            <summary title="Ver evento raw" aria-label="Ver evento raw">
              <span class="raw-chevron">⌄</span>
              <span>Raw</span>
            </summary>
            <pre>${escapeHtml(pretty(raw))}</pre>
          </details>
        </article>
      `;
    })
    .join('');
}

function renderLogs(options = {}) {
  const updateLatest = options.updateLatest !== false;
  if (!state.logs.length) {
    logList.innerHTML = '<div class="empty-state">Sin logs todavia.</div>';
    if (updateLatest) updateLatestLog();
    return;
  }
  logList.innerHTML = state.logs
    .slice(-80)
    .reverse()
    .map(
      (record) => `
        <article class="log-row ${escapeHtml(record.level)} ${escapeHtml(record.source || '')}" id="${escapeHtml(logDomId(record))}">
          <span>${escapeHtml(record.ts)}</span>
          <strong>${escapeHtml(logSource(record))}</strong>
          <p>${escapeHtml(formatLogMessage(record))}</p>
        </article>
      `
    )
    .join('');
  if (updateLatest) updateLatestLog();
}

function updateLatestLog(record = state.logs[state.logs.length - 1]) {
  const text = $('#latestLogText');
  const bar = $('#latestLogBar');
  const dot = $('#latestLogDot');
  if (!text || !bar) return;
  bar.classList.remove('info', 'warn', 'error', 'debug', 'changed');
  if (dot) dot.className = 'latest-log-dot';
  if (!record) {
    text.textContent = 'Sin comunicacion reciente.';
    delete bar.dataset.logTarget;
    state.latestLogId = '';
    return;
  }
  const nextLogId = logDomId(record);
  const changed = state.latestLogId !== nextLogId;
  state.latestLogId = nextLogId;
  const level = record.level || 'info';
  bar.classList.add(level);
  if (dot) dot.classList.add(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'success');
  bar.dataset.logTarget = nextLogId;
  const time = record.ts ? new Date(record.ts).toLocaleTimeString() : '';
  text.textContent = `${time} · ${String(record.level || 'info').toUpperCase()} · ${formatLogMessage(record)}`;
  if (changed) {
    requestAnimationFrame(() => {
      bar.classList.add('changed');
    });
  }
}

function openLatestLog() {
  const target = $('#latestLogBar')?.dataset.logTarget;
  if (!target) return;
  state.activeServiceTab = 'logs';
  state.selectedSettingsLogId = target;
  setPanel('services');
  renderServices();
  requestAnimationFrame(() => {
    const row = document.getElementById(`settings-${target}`) || document.getElementById(target);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('focused');
    window.setTimeout(() => row.classList.remove('focused'), 2400);
  });
}

function connectSse() {
  const source = new EventSource('/api/events/stream');
  source.addEventListener('snapshot', (event) => {
    const payload = JSON.parse(event.data);
    state.events = payload.events || [];
    state.logs = normalizeLogsChronological(payload.logs || []);
    renderEvents();
    renderLogs();
    renderRealtimeServiceDetail('snapshot');
    updateLatestLog();
  });
  source.addEventListener('device-event', (event) => {
    const payload = JSON.parse(event.data);
    state.events.push(payload);
    renderEvents();
    renderRealtimeServiceDetail('device-event');
  });
  source.addEventListener('log', (event) => {
    const payload = JSON.parse(event.data);
    state.logs.push(payload);
    updateLatestLog(payload);
    renderLogs({ updateLatest: false });
    renderRealtimeServiceDetail('log');
  });
}

function renderRealtimeServiceDetail(kind) {
  if (state.activeServiceTab === 'logs') {
    renderServiceDetail();
    return;
  }
  if (state.activeServiceTab === 'pedestrians') {
    if (kind === 'snapshot') renderServiceDetail();
    return;
  }
  if (state.activeServiceTab === 'hikvision-events') {
    if (state.activeFaceRecognitionTab === 'operation' && kind !== 'log') {
      renderServiceDetail();
    }
    return;
  }
  if (kind === 'snapshot') renderServiceDetail();
}

document.querySelectorAll('.nav-item').forEach((button) => {
  if (button.dataset.openOperator !== undefined) return;
  button.addEventListener('click', () => setPanel(button.dataset.panel));
});

document.querySelectorAll('[data-open-operator]').forEach((button) => {
  button.addEventListener('click', () => window.location.assign('/'));
});

$('#serviceSidebarMenu')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-service-sidebar]');
  if (!button) return;
  state.activeServiceTab = button.dataset.serviceSidebar;
  setPanel('services');
  renderServices();
});

document.querySelectorAll('[data-task-tab]').forEach((button) => {
  button.addEventListener('click', () => setTaskTab(button.dataset.taskTab));
});

document.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab));
});

document.querySelectorAll('[data-events-tab]').forEach((button) => {
  button.addEventListener('click', () => setEventsTab(button.dataset.eventsTab));
});

document.querySelectorAll('[data-edit-tab]').forEach((button) => {
  button.addEventListener('click', () => setEditTab(button.dataset.editTab));
});

$('#refreshBtn')?.addEventListener('click', () => {
  refreshHealth().catch((error) => addMessage('assistant', error.message));
});

$('#refreshServicesBtn').addEventListener('click', () => {
  loadServices().catch((error) => addMessage('assistant', error.message, { error: true }));
});

$('#serviceGrid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-service-action]');
  if (!button) return;
  controlService(button.dataset.serviceId, button.dataset.serviceAction).catch((error) =>
    addMessage('assistant', error.message, { error: true })
  );
});

$('#serviceTabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-service-tab]');
  if (!button) return;
  state.activeServiceTab = button.dataset.serviceTab;
  renderServices();
});

$('#serviceDetail').addEventListener('click', (event) => {
  const permissionDetail = event.target.closest('[data-permission-detail-id]');
  if (permissionDetail) {
    openPermissionDetail(permissionDetail.dataset.permissionDetailKind, permissionDetail.dataset.permissionDetailId);
    return;
  }

  if (event.target.closest('[data-settings-log-back]')) {
    state.selectedSettingsLogId = '';
    renderServiceDetail();
    return;
  }

  const settingsLogRow = event.target.closest('[data-settings-log-id]');
  if (settingsLogRow) {
    state.selectedSettingsLogId = settingsLogRow.dataset.settingsLogId;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-settings-logs-refresh]')) {
    state.settingsLogsLoaded = false;
    loadSettingsLogs().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const pedestrianTab = event.target.closest('[data-pedestrian-tab]');
  if (pedestrianTab) {
    state.activePedestrianTab = pedestrianTab.dataset.pedestrianTab;
    renderServiceDetail();
    return;
  }

  const vehicleTab = event.target.closest('[data-vehicle-tab]');
  if (vehicleTab) {
    state.activeVehicleTab = vehicleTab.dataset.vehicleTab;
    renderServiceDetail();
    return;
  }

  const syncTab = event.target.closest('[data-sync-tab]');
  if (syncTab) {
    state.activeSyncTab = syncTab.dataset.syncTab;
    state.syncDeviceMessage = '';
    state.syncDeviceError = '';
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-sync-permissions-download]')) {
    downloadEoloUsersFromCloud().catch((error) => {
      state.syncPermissionsError = error.message;
      showEoloSyncDebug({ ok: false, message: `Descarga permisos: ${error.message}`, error: true });
      addMessage('assistant', error.message, { error: true });
      renderServiceDetail();
    });
    return;
  }

  if (event.target.closest('[data-sync-permission-search-clear]')) {
    setSyncPermissionSearchValue('');
    renderServiceDetail();
    return;
  }

  const syncPermissionPage = event.target.closest('[data-sync-permission-page]');
  if (syncPermissionPage) {
    state.syncPermissionPage = Math.max(1, Number(syncPermissionPage.dataset.syncPermissionPage || 1));
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-vehicle-refresh]')) {
    state.vehiclePermissionsAccessId = '';
    state.vehiclePermissionsLoaded = false;
    state.vehicleAnprMenuOpen = false;
    loadServices()
      .catch((error) => addMessage('assistant', error.message, { error: true }));
    return;
  }

  if (event.target.closest('[data-vehicle-anpr-menu-toggle]')) {
    state.vehicleAnprMenuOpen = !state.vehicleAnprMenuOpen;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-identification-refresh]')) {
    state.operatorIdentificationLoaded = false;
    state.operatorIdentificationMessage = '';
    loadIdentificationReaderSettings().catch((error) => {
      state.operatorIdentificationError = error.message;
      renderServiceDetail();
    });
    return;
  }

  if (event.target.closest('[data-cloud-sync-refresh]')) {
    state.operatorCloudLoaded = false;
    state.operatorCloudMessage = '';
    loadCloudSyncSettings().catch((error) => {
      state.operatorCloudError = error.message;
      renderServiceDetail();
    });
    return;
  }

  if (event.target.closest('[data-bridge-settings-refresh]')) {
    state.operatorBridgeLoaded = false;
    state.operatorBridgeMessage = '';
    loadBridgeSettings().catch((error) => {
      state.operatorBridgeError = error.message;
      renderServiceDetail();
    });
    return;
  }

  if (event.target.closest('[data-pedestrian-permissions-refresh]')) {
    state.pedestrianPermissionsAccessId = '';
    state.pedestrianPermissionsLoaded = false;
    loadPedestrianPermissions().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  if (event.target.closest('[data-vehicle-permissions-refresh]')) {
    state.vehiclePermissionsAccessId = '';
    state.vehiclePermissionsLoaded = false;
    loadVehiclePermissions().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const permissionClear = event.target.closest('[data-permission-search-clear]');
  if (permissionClear) {
    setPermissionSearchValue(permissionClear.dataset.permissionSearchClear, '');
    renderServiceDetail();
    return;
  }

  const permissionPage = event.target.closest('[data-permission-page]');
  if (permissionPage) {
    setPermissionPageValue(permissionPage.dataset.permissionPage, permissionPage.dataset.page);
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-face-device-back]')) {
    state.selectedManagedFaceDeviceId = '';
    state.faceDeviceLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-face-devices-start-enabled]')) {
    startEnabledFaceDevices().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  if (event.target.closest('[data-vehicle-camera-back]')) {
    state.selectedVehicleCameraIndex = '';
    state.vehicleCameraLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-vehicle-camera-new]')) {
    state.selectedVehicleCameraIndex = 'new';
    state.vehicleCameraLastResult = null;
    renderServiceDetail();
    return;
  }

  const vehicleCameraEdit = event.target.closest('[data-vehicle-camera-edit]');
  if (vehicleCameraEdit) {
    state.selectedVehicleCameraIndex = vehicleCameraEdit.dataset.vehicleCameraEdit;
    state.vehicleCameraLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-barrier-back]')) {
    state.selectedBarrierIndex = '';
    state.barrierLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-barrier-new]')) {
    state.selectedBarrierIndex = 'new';
    state.barrierLastResult = null;
    renderServiceDetail();
    return;
  }

  const barrierEdit = event.target.closest('[data-barrier-edit]');
  if (barrierEdit) {
    state.selectedBarrierIndex = barrierEdit.dataset.barrierEdit;
    state.barrierLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-face-devices-stop-all]')) {
    stopAllFaceDevices().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const managedSelect = event.target.closest('[data-face-device-select]');
  if (managedSelect) {
    state.selectedManagedFaceDeviceId = managedSelect.dataset.faceDeviceSelect;
    state.faceDeviceLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-face-device-new]')) {
    state.selectedManagedFaceDeviceId = 'new';
    state.faceDeviceLastResult = null;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('[data-face-device-cloud-options-retry]')) {
    state.faceDeviceCloudOptionsLoaded = false;
    state.faceDeviceCloudOptionsError = '';
    loadManagedFaceDeviceCloudOptions(pedestrianAccessContext().id).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  if (event.target.closest('[data-face-device-save]')) {
    saveManagedFaceDevice().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  if (event.target.closest('[data-face-device-test]')) {
    testManagedFaceDevice().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const streamButton = event.target.closest('[data-face-device-stream]');
  if (streamButton) {
    toggleManagedFaceDeviceStream(streamButton.dataset.faceDeviceStream).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const syncButton = event.target.closest('[data-face-device-sync]');
  if (syncButton) {
    syncManagedFaceDevice(syncButton.dataset.faceDeviceSync).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const deleteButton = event.target.closest('[data-face-device-delete]');
  if (deleteButton) {
    deleteManagedFaceDevice().catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  const faceDeviceTab = event.target.closest('[data-face-device-tab]');
  if (faceDeviceTab) {
    state.activeFaceDeviceTab = faceDeviceTab.dataset.faceDeviceTab;
    state.faceDeviceTabTouched = true;
    renderServiceDetail();
    syncFaceDeviceControls();
    return;
  }

  const faceTab = event.target.closest('[data-face-tab]');
  if (faceTab) {
    state.activeFaceRecognitionTab = faceTab.dataset.faceTab;
    renderServiceDetail();
    return;
  }

  const anprProcessorTab = event.target.closest('[data-anpr-processor-tab]');
  if (anprProcessorTab) {
    state.activeAnprProcessorTab = anprProcessorTab.dataset.anprProcessorTab;
    renderServiceDetail();
    return;
  }

  if (event.target.closest('#streamBtn')) {
    toggleStream().catch((error) => addMessage('assistant', error.message));
    return;
  }

  if (event.target.closest('[data-add-camera]')) {
    const rows = $('#hardwareCameraRows');
    rows?.insertAdjacentHTML(
      'beforeend',
      renderCameraEditorRow(emptyCamera(), rows.querySelectorAll('[data-camera-row]').length, anprHardware().barriers || [])
    );
    return;
  }

  if (event.target.closest('[data-add-barrier]')) {
    const rows = $('#hardwareBarrierRows');
    rows?.insertAdjacentHTML('beforeend', renderBarrierEditorRow(emptyBarrier(), rows.querySelectorAll('[data-barrier-row]').length));
    return;
  }

  const removeHardwareRow = event.target.closest('[data-remove-hardware-row]');
  if (removeHardwareRow) {
    const row = removeHardwareRow.closest('[data-camera-row], [data-barrier-row]');
    const list = row?.parentElement;
    row?.remove();
    if (list && !list.children.length) {
      const isCameraList = list.id === 'hardwareCameraRows';
      list.insertAdjacentHTML(
        'beforeend',
        isCameraList
          ? renderCameraEditorRow(emptyCamera(), 0, anprHardware().barriers || [])
          : renderBarrierEditorRow(emptyBarrier(), 0)
      );
    }
    return;
  }

  const actionButton = event.target.closest('[data-service-action]');
  if (actionButton) {
    state.vehicleAnprMenuOpen = false;
    controlService(actionButton.dataset.serviceId, actionButton.dataset.serviceAction).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  if (event.target.closest('[data-run-users-sync]')) {
    runEoloUserSync().then(() => loadServices()).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }

  if (event.target.closest('[data-download-cloud-users]')) {
    downloadEoloUsersFromCloud().catch((error) => {
      showEoloSyncDebug({ ok: false, message: `Descarga Cloud: ${error.message}`, error: true });
      addMessage('assistant', error.message, { error: true });
    });
    return;
  }

  if (event.target.closest('[data-apply-device-users]')) {
    applyEoloUsersToDevice().catch((error) => {
      showEoloSyncDebug({ ok: false, message: `Carga dispositivo: ${error.message}`, error: true });
      addMessage('assistant', error.message, { error: true });
    });
    return;
  }

  if (event.target.closest('[data-run-task-poll]')) {
    runEoloTaskPoll().catch((error) => addMessage('assistant', error.message, { error: true }));
    return;
  }

  if (event.target.closest('[data-run-visit-sync]')) {
    runVisitSyncNow().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
});

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-permission-detail-close]') || event.target.matches('.permission-detail-backdrop')) {
    closePermissionDetail();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.selectedPermissionDetail) closePermissionDetail();
});

$('#serviceDetail').addEventListener('change', (event) => {
  if (event.target.closest('[data-managed-face-device-type]')) {
    updateManagedFaceDeviceTypeSections();
  }
  if (event.target.closest('[data-managed-face-control-point]')) {
    syncManagedFaceDeviceControlPointName();
  }
  if (event.target.matches('#identificationReaderForm [name="enabled"], #identificationReaderForm [name="changeApiKey"]')) {
    syncIdentificationReaderControls();
  }
  if (event.target.matches('#identificationReaderForm [name="cameraId"]')) {
    state.selectedOperatorCameraId = event.target.value;
  }
  if (event.target.closest('[data-cloud-branch-preset]')) {
    syncCloudSyncControls();
  }
  if (event.target.matches('#syncDeviceForm [name="userSyncEnabled"], #syncDeviceForm [name="changeToken"]')) {
    syncSyncDeviceControls();
  }
});

$('#serviceDetail').addEventListener('input', (event) => {
  const syncInput = event.target.closest('[data-sync-permission-search]');
  if (syncInput) {
    const value = syncInput.value;
    setSyncPermissionSearchValue(value);
    renderServiceDetail();
    requestAnimationFrame(() => {
      const nextInput = $('#serviceDetail [data-sync-permission-search]');
      if (!nextInput) return;
      nextInput.focus();
      nextInput.setSelectionRange(value.length, value.length);
    });
    return;
  }

  const input = event.target.closest('[data-permission-search]');
  if (!input) return;
  const kind = input.dataset.permissionSearch;
  const value = input.value;
  setPermissionSearchValue(kind, value);
  renderServiceDetail();
  requestAnimationFrame(() => {
    const nextInput = $(`#serviceDetail [data-permission-search="${kind}"]`);
    if (!nextInput) return;
    nextInput.focus();
    nextInput.setSelectionRange(value.length, value.length);
  });
});

$('#serviceDetail').addEventListener('submit', (event) => {
  if (event.target.matches('[data-sync-permission-search-form]')) {
    event.preventDefault();
    return;
  }
  if (event.target.matches('[data-permission-search-form]')) {
    event.preventDefault();
    return;
  }
  if (event.target.matches('#vehicleCameraForm')) {
    event.preventDefault();
    saveVehicleCamera(event.target).catch((error) => addMessage('assistant', error.message, { error: true }));
    return;
  }
  if (event.target.matches('#barrierDeviceForm')) {
    event.preventDefault();
    saveBarrierDevice(event.target).catch((error) => addMessage('assistant', error.message, { error: true }));
    return;
  }
  if (event.target.matches('#identificationReaderForm')) {
    event.preventDefault();
    saveIdentificationReaderSettings(event.target).catch((error) => {
      state.operatorIdentificationError = error.message;
      renderServiceDetail();
      addMessage('assistant', error.message, { error: true });
    });
    return;
  }
  if (event.target.matches('#cloudSyncForm')) {
    event.preventDefault();
    saveCloudSyncSettings(event.target).catch((error) => {
      state.operatorCloudError = error.message;
      renderServiceDetail();
      addMessage('assistant', error.message, { error: true });
    });
    return;
  }
  if (event.target.matches('#bridgeSettingsForm')) {
    event.preventDefault();
    saveBridgeSettings(event.target).catch((error) => {
      state.operatorBridgeError = error.message;
      renderServiceDetail();
      addMessage('assistant', error.message, { error: true });
    });
    return;
  }
  if (event.target.matches('#syncDeviceForm')) {
    event.preventDefault();
    saveSyncDeviceSettings(event.target).catch((error) => {
      state.syncDeviceError = error.message;
      renderServiceDetail();
      addMessage('assistant', error.message, { error: true });
    });
    return;
  }
  if (event.target.matches('#anprHardwareForm')) {
    event.preventDefault();
    saveAnprHardware(event.target).catch((error) => addMessage('assistant', error.message, { error: true }));
    return;
  }
  if (event.target.matches('#anprConfigForm')) {
    event.preventDefault();
    saveAnprConfig(event.target).catch((error) => addMessage('assistant', error.message, { error: true }));
  }
});

$('#latestLogBar').addEventListener('click', openLatestLog);

$('#latestLogBar').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openLatestLog();
  }
});

$('#commandForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#commandInput');
  handleCommand(input.value).catch((error) => addMessage('assistant', error.message));
  input.value = '';
});

$('#employeeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.action || 'create';
  submitEmployee(event.currentTarget, action).catch((error) => addMessage('assistant', error.message));
});

$('#employeeSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadEmployees($('#employeeSearchInput').value.trim(), 0).catch((error) =>
    addMessage('assistant', error.message, { error: true })
  );
});

$('#refreshEmployeesBtn').addEventListener('click', () => {
  $('#employeeSearchInput').value = '';
  loadEmployees('', 0).catch((error) => addMessage('assistant', error.message, { error: true }));
});

$('#employeeTable').addEventListener('click', (event) => {
  const pageButton = event.target.closest('[data-employee-page]');
  if (pageButton) {
    const direction = pageButton.dataset.employeePage;
    const delta = direction === 'next' ? 1 : -1;
    loadEmployees(state.employeePage.filter, state.employeePage.page + delta).catch((error) =>
      addMessage('assistant', error.message, { error: true })
    );
    return;
  }
  const edit = event.target.closest('[data-edit-employee]');
  if (edit) openEditEmployee(edit.dataset.editEmployee);
  const del = event.target.closest('[data-delete-employee]');
  if (del) openDeleteEmployee(del.dataset.deleteEmployee);
});

$('#editEmployeeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitEditEmployee(event.currentTarget).catch((error) =>
    addMessage('assistant', error.message, { error: true })
  );
});

$('#editEmployeeFaceForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitEditEmployeeFace(event.currentTarget).catch((error) =>
    addMessage('assistant', error.message, { error: true })
  );
});

$('#deleteEmployeeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitDeleteEmployee(event.currentTarget).catch((error) =>
    addMessage('assistant', error.message, { error: true })
  );
});

document.querySelectorAll('[data-close-modal]').forEach((button) => {
  button.addEventListener('click', () => {
    document.getElementById(button.dataset.closeModal)?.close();
  });
});

$('#deviceConfigForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const isEoloTab = $('#eoloSettingsPanel')?.classList.contains('active');
  const action = isEoloTab ? saveEoloConfig : saveDeviceConfig;
  action().catch((error) => addMessage('assistant', error.message, { error: true }));
});

$('#deviceConfigForm').addEventListener('click', (event) => {
  const testButton = event.target.closest('[data-test-device-config]');
  if (testButton) {
    activateFaceDeviceTab(testButton.dataset.testDeviceConfig);
    testDeviceConfig().catch((error) => addMessage('assistant', error.message));
    return;
  }

  const saveButton = event.target.closest('[data-save-device-config]');
  if (saveButton) {
    activateFaceDeviceTab(saveButton.dataset.saveDeviceConfig);
    saveDeviceConfig().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
});

$('#deviceConfigForm').elements.changePassword.addEventListener('change', () => {
  syncPasswordControls();
});

$('#deviceConfigForm').elements.changeDahuaPassword.addEventListener('change', () => {
  syncDahuaPasswordControls();
});

$('#deviceConfigForm').elements.changeEoloToken.addEventListener('change', () => {
  syncEoloTokenControls();
});

$('#deviceConfigForm').elements.eoloUserSyncEnabled.addEventListener('change', () => {
  syncEoloTokenControls();
});

$('#clearValidationBtn').addEventListener('click', () => {
  const node = $('#validationResult');
  node.classList.remove('ok', 'fail');
  node.textContent = 'Sin prueba reciente.';
  $('#deviceInfo').textContent = '{}';
});

$('#clearEoloSyncDebugBtn').addEventListener('click', () => {
  const node = $('#eoloSyncResult');
  node.classList.remove('ok', 'fail');
  node.textContent = 'Sin prueba reciente.';
  $('#eoloSyncInfo').textContent = '{}';
});

$('#syncEoloUsersBtn')?.addEventListener('click', () => {
  downloadEoloUsersFromCloud().catch((error) => {
    showEoloSyncDebug({ ok: false, message: `Descarga Cloud: ${error.message}`, error: true });
    addMessage('assistant', error.message, { error: true });
  });
});

$('#saveEoloConfigBtn').addEventListener('click', () => {
  saveEoloConfig().catch((error) => {
    showEoloSyncDebug({ ok: false, message: error.message, error: true });
    addMessage('assistant', error.message, { error: true });
  });
});

$('#mockEventBtn').addEventListener('click', () => {
  api('/api/mock/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeNo: '1001', name: 'Persona de prueba' })
  }).catch((error) => addMessage('assistant', error.message));
});

addMessage(
  'assistant',
  'Listo para operar.'
);
renderServiceSidebar();
connectSse();
refreshHealth().catch((error) => addMessage('assistant', error.message));
loadServices().catch((error) => addMessage('assistant', error.message, { error: true }));
if ($('#employeesPanel')?.classList.contains('active') && $('#directoryTaskPanel')?.classList.contains('active')) {
  loadEmployees().catch((error) => addMessage('assistant', error.message, { error: true }));
}
