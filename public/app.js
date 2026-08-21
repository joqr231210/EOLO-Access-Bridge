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
  activeServiceTab: 'hikvision-events',
  activeFaceRecognitionTab: 'operation',
  activeAnprProcessorTab: 'summary',
  deviceCommunicationOk: false,
  lastLocalCommunicationAt: null,
  employees: [],
  employeeDirectoryLoaded: false,
  employeePage: {
    page: 0,
    pageSize: 12,
    total: 0,
    filter: ''
  }
};

const $ = (selector) => document.querySelector(selector);
const chatWindow = $('#chatWindow');
const eventList = $('#eventList');
const logList = $('#logList');

const serviceTabs = [
  { id: 'hikvision-events', label: 'Face Recognition', title: 'Face Recognition' },
  { id: 'eolo-users-sync', label: 'Residentes Sync', title: 'Residentes Sync' },
  { id: 'eolo-task-poller', label: 'Tareas Pooling', title: 'Tareas Pooling' },
  { id: 'anpr-api', label: 'Local API ANPR', title: 'Local API ANPR' },
  { id: 'anpr-processor', label: 'Procesador ANPR', title: 'Procesador ANPR' },
  { id: 'barriers', label: 'Barreras', title: 'Barreras' },
  { id: 'rtsp-preview', label: 'Visualizador Cámaras', title: 'Visualizador Cámaras' },
  { id: 'webrtc-preview', label: 'WebRTC', title: 'Visualizador WebRTC' },
  { id: 'visit-sync', label: 'Visitas Sync', title: 'Visitas Sync' }
];

const api = async (path, options = {}) => {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || response.statusText);
  }
  return payload;
};

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

function logDomId(record) {
  const raw = `${record.ts || ''}-${record.level || ''}-${record.message || ''}`;
  return `log-${raw.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function formatLogMessage(record) {
  if (record.message === 'Sincronizacion de usuarios EOLO completada') {
    return formatEoloSyncSummary(record);
  }
  const detail = record.meta?.error || record.meta?.status;
  return detail ? `${record.message}: ${detail}` : record.message;
}

function formatEoloSyncSummary(record) {
  const meta = record.meta || {};
  const created = meta.created || [];
  const updated = meta.updated || [];
  const deleted = meta.deleted || [];
  const facesUpdated = meta.facesUpdated || [];
  const skippedFaces = meta.skippedFaces || [];
  const skippedInvalid = Number(meta.skippedInvalid || 0);
  const parts = [
    `nube ${meta.validCloudCount ?? meta.cloudCount ?? 0}/${meta.cloudCount ?? 0}`,
    listSummary('creados', created),
    listSummary('actualizados', updated),
    listSummary('borrados', deleted),
    listSummary('rostros', facesUpdated)
  ];
  if (skippedFaces.length) parts.push(`${skippedFaces.length} rostros con error`);
  if (skippedInvalid) parts.push(`${skippedInvalid} registros invalidos`);
  return `${record.message}: ${parts.join(' · ')}`;
}

function listSummary(label, values = []) {
  const count = values.length;
  if (!count) return `${label} 0`;
  const ids = values.slice(0, 4).join(', ');
  const extra = count > 4 ? ` +${count - 4}` : '';
  return `${label} ${count} (${ids}${extra})`;
}

function logSource(record) {
  return record.source === 'ui' ? 'ui' : record.source || record.level || 'log';
}

function setPanel(panelName) {
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
  const [health, configPayload, info] = await Promise.all([
    api('/api/health'),
    api('/api/device-config'),
    api('/api/device-info').catch((error) => ({ error: error.message }))
  ]);
  state.health = health;
  state.deviceConfig = configPayload;
  state.deviceCommunicationOk = updateOperationalStatus(health, configPayload, info);
  updateStreamToggle(health);
  $('#deviceInfo').textContent = pretty({ health, config: configPayload, ...info });
  $('#mockEventBtn').hidden = health.mode !== 'mock';
  fillDeviceConfigForm(configPayload);
  updateBridgeBrand(configPayload);
}

function updateBridgeBrand(payload) {
  const text = $('#bridgeIdentifierText');
  if (!text) return;
  text.textContent = payload?.hikvision?.bridgeIdentifier || 'Nuevo Dispositivo Bridge';
}

function updateOperationalStatus(health, configPayload, info = {}) {
  const device = configPayload?.hikvision || {};
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
  const syncReady = Boolean(syncStatus.enabled && syncStatus.accessSet && syncStatus.tokenSet);
  const syncMissing = [
    !syncStatus.enabled ? 'opcion desactivada' : '',
    !syncStatus.accessSet ? 'acceso faltante' : '',
    !syncStatus.localDeviceIdSet ? 'ID dispositivo faltante' : '',
    !syncStatus.tokenSet ? 'token faltante' : ''
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
  const [payload, anprDashboard, anprHardware] = await Promise.all([
    api('/api/services'),
    api('/api/anpr/dashboard').catch((error) => ({ ok: false, error: error.message })),
    api('/api/anpr/hardware').catch((error) => ({ ok: false, error: error.message }))
  ]);
  state.services = payload.services || [];
  state.anprDashboardError = anprDashboard.ok === false ? anprDashboard.error : null;
  state.anprDashboard = anprDashboard.ok === false ? null : anprDashboard;
  state.anprHardwareError = anprHardware.ok === false ? anprHardware.error : null;
  state.anprHardware = anprHardware.ok === false ? state.anprHardware : anprHardware;
  ensureActiveServiceTab();
  renderServices();
  return payload;
}

async function controlService(serviceId, action) {
  const payload = await api(`/api/services/${encodeURIComponent(serviceId)}/${action}`, {
    method: 'POST'
  });
  state.services = payload.services || [];
  if (state.activeServiceTab === serviceId || serviceId.startsWith('anpr') || serviceId === 'barriers' || serviceId === 'visit-sync' || serviceId === 'rtsp-preview' || serviceId === 'webrtc-preview') {
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
  const tab = serviceTabs.find((item) => item.id === state.activeServiceTab) || serviceTabs[0];
  const service = serviceById(tab.id);
  const renderers = {
    'hikvision-events': renderHikvisionServiceView,
    'eolo-users-sync': renderEoloUsersServiceView,
    'eolo-task-poller': renderEoloTasksServiceView,
    'anpr-api': renderAnprApiServiceView,
    'anpr-processor': renderAnprProcessorServiceView,
    barriers: renderBarriersServiceView,
    'rtsp-preview': renderRtspPreviewServiceView,
    'webrtc-preview': renderWebrtcPreviewServiceView,
    'visit-sync': renderVisitSyncServiceView
  };
  detail.innerHTML = `
    <div class="service-detail-header">
      <div>
        <h3>${escapeHtml(tab.title)}</h3>
        <p>${escapeHtml(service.description || 'Vista operativa del servicio seleccionado.')}</p>
      </div>
      ${renderServiceStatusPill(service)}
    </div>
    ${(renderers[tab.id] || renderEmptyServiceView)(service)}
  `;
  mountEmployeeWorkspace();
  updateStreamToggle();
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

function renderHikvisionServiceView() {
  const employeesActive = state.activeFaceRecognitionTab === 'employees';
  return `
    <div class="service-inner-tabs" role="tablist" aria-label="Face Recognition">
      <button class="service-inner-tab ${employeesActive ? '' : 'active'}" type="button" data-face-tab="operation">Operacion</button>
      <button class="service-inner-tab ${employeesActive ? 'active' : ''}" type="button" data-face-tab="employees">Empleados</button>
    </div>
    ${employeesActive ? renderFaceEmployeesView() : renderFaceOperationView()}
  `;
}

function renderFaceOperationView() {
  const stream = state.health?.stream || {};
  const device = state.deviceConfig?.hikvision || {};
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
          { label: 'ID dispositivo local', value: sync.localDeviceIdSet ? 'Configurado' : 'Pendiente' },
          { label: 'Token', value: sync.tokenSet ? 'Guardado' : 'Pendiente' },
          { label: 'Ejecucion en curso', value: sync.running ? 'Si' : 'No' }
        ])}
        <div class="inline-actions">
          <button type="button" data-run-users-sync>Sincronizar ahora</button>
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
  const hardware = anprHardware();
  const status = serviceById('barriers');
  const barrierCount = (hardware.barriers || []).length || (anprConfig().barriers || []).length;
  return `
    ${renderAnprUnavailable()}
    ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
    ${renderMetrics([
      { label: 'Estado', value: status.status === 'ready' ? 'Listo' : status.status || '-' },
      { label: 'Barreras', value: barrierCount },
      { label: 'Tipo', value: 'ISAPI' },
      { label: 'Uso', value: 'Activacion ANPR' }
    ])}
    <section class="service-section wide">
      <h4>Barreras ISAPI</h4>
      ${renderBarrierHardwareEditor(hardware)}
    </section>
  `;
}

function renderRtspPreviewServiceView() {
  const hardware = anprHardware();
  const status = anprService('rtsp-preview');
  const webrtcStatus = serviceById('webrtc-preview') || {};
  const cameraCount = (hardware.cameras || []).length || (anprConfig().cameras || []).length;
  return `
    ${renderAnprUnavailable()}
    ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
    ${renderMetrics([
      { label: 'WebRTC', value: webrtcStatus.running ? 'Activo' : 'Detenido' },
      { label: 'MSE', value: status.running ? 'Activo' : 'Detenido' },
      { label: 'Camara(s)', value: cameraCount },
      { label: 'Latencia', value: webrtcStatus.running ? 'Baja' : 'Fallback' }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>WebRTC recomendado</h4>
        ${renderServiceActions('webrtc-preview')}
        ${renderDefinitionList([
          { label: 'Publicacion', value: webrtcStatus.publicUrl || 'http://localhost:1984' },
          { label: 'ICE', value: webrtcStatus.port ? `TCP/UDP ${webrtcStatus.port}` : 'TCP/UDP 8555' },
          { label: 'Uso', value: 'Reproductor principal del operador' }
        ])}
      </section>
      <section class="service-section">
        <h4>Fallback MSE</h4>
        ${renderServiceActions('rtsp-preview')}
        ${renderDefinitionList([
          { label: 'Publicacion', value: 'http://localhost:8083' },
          { label: 'Puerto', value: '8083' },
          { label: 'Uso', value: 'Compatibilidad si WebRTC no esta disponible' }
        ])}
      </section>
      <section class="service-section wide">
        <h4>Cámaras disponibles</h4>
        ${renderTable(
          [
            { label: 'Nombre', value: 'name' },
            { label: 'Tipo', value: 'type' },
            { label: 'Prefijo', value: 'prefix' }
          ],
          hardware.cameras || [],
          'Sin cámaras disponibles para previsualizar.'
        )}
      </section>
    </div>
  `;
}

function renderWebrtcPreviewServiceView() {
  const hardware = anprHardware();
  const status = serviceById('webrtc-preview') || {};
  const cameraCount = (hardware.cameras || []).length || (anprConfig().cameras || []).length;
  return `
    ${renderAnprUnavailable()}
    ${state.anprHardwareError ? `<div class="service-warning">No se pudo cargar hardware editable: ${escapeHtml(state.anprHardwareError)}</div>` : ''}
    ${renderMetrics([
      { label: 'WebRTC', value: status.running ? 'Activo' : 'Detenido' },
      { label: 'PID', value: status.pid || '-' },
      { label: 'Camara(s)', value: cameraCount },
      { label: 'Puerto ICE', value: status.port || '8555' }
    ])}
    <div class="service-section-grid">
      <section class="service-section">
        <h4>Control WebRTC</h4>
        ${renderServiceActions('webrtc-preview')}
        ${renderDefinitionList([
          { label: 'WebUI', value: status.publicUrl || 'http://localhost:1984' },
          { label: 'API interna', value: status.apiUrl || 'http://127.0.0.1:1984' },
          { label: 'Recomendacion', value: 'Usar H.264/substream para menor carga' }
        ])}
      </section>
      <section class="service-section">
        <h4>Puertos Docker</h4>
        ${renderDefinitionList([
          { label: 'HTTP', value: '1984/tcp' },
          { label: 'ICE', value: '8555/tcp + 8555/udp' },
          { label: 'LAN', value: 'ANPR_WEBRTC_ICE_HOST=IP del equipo Docker' }
        ])}
      </section>
    </div>
  `;
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
  const eolo = payload.eolo || {};
  const hasSavedPassword = Boolean(device.passwordSet);
  const hasSavedEoloToken = Boolean(eolo.tokenSet);
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
  form.elements.eoloUserSyncEndpoint.value = eolo.userSyncEndpoint || '';
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

  const employeeForm = $('#employeeForm');
  if (employeeForm) {
    employeeForm.elements.doorNo.value = device.doorNo || 1;
    employeeForm.elements.planTemplateNo.value = device.planTemplateNo || '1';
  }
}

function readDeviceConfigForm() {
  const form = $('#deviceConfigForm');
  const data = Object.fromEntries(new FormData(form).entries());
  const hasSavedPassword = Boolean(state.deviceConfig?.hikvision?.passwordSet);
  const shouldChangePassword = !hasSavedPassword || form.elements.changePassword.checked;
  const hasSavedEoloToken = Boolean(state.deviceConfig?.eolo?.tokenSet);
  const shouldChangeEoloToken = !hasSavedEoloToken || form.elements.changeEoloToken.checked;
  return {
    mockDevice: form.elements.mockDevice.checked,
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
  form.elements.password.required = changingPassword;
  form.elements.password.placeholder = changingPassword
    ? 'Nueva contrasena del dispositivo'
    : 'Contrasena guardada; activa cambiar para reemplazarla';
  $('#credentialHint').textContent = hasSavedPassword
    ? 'La contrasena guardada se conserva si no activas el cambio.'
    : 'No hay contrasena guardada; captura una para comunicarte con el dispositivo.';
}

function syncEoloTokenControls() {
  const form = $('#deviceConfigForm');
  if (!form) return;
  const hasSavedToken = Boolean(state.deviceConfig?.eolo?.tokenSet);
  const changingToken = !hasSavedToken || form.elements.changeEoloToken.checked;
  const syncEnabled = form.elements.eoloUserSyncEnabled.checked;
  form.elements.eoloUserSyncEndpoint.required = syncEnabled;
  form.elements.eoloAccess.required = syncEnabled;
  form.elements.eoloToken.disabled = !changingToken;
  form.elements.eoloToken.required = syncEnabled && changingToken;
  form.elements.eoloToken.placeholder = changingToken
    ? 'Token Bearer de EOLO'
    : 'Token guardado; activa cambiar para reemplazarlo';
  $('#eoloTokenHint').textContent = hasSavedToken
    ? 'El token guardado se conserva si no activas el cambio.'
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
    message: 'Configuracion de sincronizacion EOLO guardada. Ejecutando sincronizacion.',
    eolo: saveResult.config?.eolo
  });
  addMessage('assistant', 'Configuracion EOLO guardada. Iniciando sincronizacion.', {
    ok: true,
    eolo: saveResult.config?.eolo
  });
  await refreshHealth();

  try {
    await runEoloUserSync();
  } catch (error) {
    showEoloSyncDebug({
      ok: false,
      message: `Configuracion EOLO guardada, pero la sincronizacion no se pudo ejecutar: ${error.message}`,
      error: true,
      save: saveResult
    });
    addMessage('assistant', error.message, { error: true });
    await refreshHealth();
  }
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

function formatEoloRunMessage(result = {}) {
  if (result.skipped) {
    return `Sincronizacion EOLO omitida: ${result.reason || 'ya hay una sincronizacion en curso'}.`;
  }
  return `Sincronizacion EOLO: ${(result.created || []).length} creados, ${(result.updated || []).length} actualizados, ${(result.deleted || []).length} eliminados, ${(result.facesUpdated || []).length} rostros.`;
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

function renderLogs() {
  if (!state.logs.length) {
    logList.innerHTML = '<div class="empty-state">Sin logs todavia.</div>';
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
  updateLatestLog();
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
    return;
  }
  const level = record.level || 'info';
  bar.classList.add(level);
  if (dot) dot.classList.add(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'success');
  bar.dataset.logTarget = logDomId(record);
  const time = record.ts ? new Date(record.ts).toLocaleTimeString() : '';
  text.textContent = `${time} · ${String(record.level || 'info').toUpperCase()} · ${formatLogMessage(record)}`;
  requestAnimationFrame(() => {
    bar.classList.add('changed');
  });
}

function openLatestLog() {
  const target = $('#latestLogBar')?.dataset.logTarget;
  if (!target) return;
  setPanel('events');
  setEventsTab('logs');
  requestAnimationFrame(() => {
    const row = document.getElementById(target);
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
    state.logs = payload.logs || [];
    renderEvents();
    renderLogs();
    renderServiceDetail();
    updateLatestLog();
  });
  source.addEventListener('device-event', (event) => {
    const payload = JSON.parse(event.data);
    state.events.push(payload);
    renderEvents();
    renderServiceDetail();
  });
  source.addEventListener('log', (event) => {
    const payload = JSON.parse(event.data);
    state.logs.push(payload);
    updateLatestLog(payload);
    renderLogs();
    renderServiceDetail();
  });
}

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => setPanel(button.dataset.panel));
});

$('#serviceSidebarMenu')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-service-sidebar]');
  if (!button) return;
  state.activeServiceTab = button.dataset.serviceSidebar;
  setPanel('services');
  renderServiceSidebar();
  renderServiceTabs();
  renderServiceDetail();
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
  renderServiceSidebar();
  renderServiceTabs();
  renderServiceDetail();
});

$('#serviceDetail').addEventListener('click', (event) => {
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

  if (event.target.closest('[data-run-task-poll]')) {
    runEoloTaskPoll().catch((error) => addMessage('assistant', error.message, { error: true }));
    return;
  }

  if (event.target.closest('[data-run-visit-sync]')) {
    runVisitSyncNow().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
});

$('#serviceDetail').addEventListener('submit', (event) => {
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

$('#deviceConfigForm').elements.changePassword.addEventListener('change', () => {
  syncPasswordControls();
});

$('#deviceConfigForm').elements.changeEoloToken.addEventListener('change', () => {
  syncEoloTokenControls();
});

$('#deviceConfigForm').elements.eoloUserSyncEnabled.addEventListener('change', () => {
  syncEoloTokenControls();
});

$('#testConfigBtn').addEventListener('click', () => {
  testDeviceConfig().catch((error) => addMessage('assistant', error.message));
});

$('#saveDeviceConfigBtn').addEventListener('click', () => {
  saveDeviceConfig().catch((error) => addMessage('assistant', error.message, { error: true }));
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

$('#syncEoloUsersBtn').addEventListener('click', () => {
  runEoloUserSync().catch((error) => {
    showEoloSyncDebug({ ok: false, message: error.message, error: true });
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
