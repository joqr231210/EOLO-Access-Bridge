const state = {
  health: null,
  deviceConfig: null,
  events: [],
  logs: [],
  deviceCommunicationOk: false,
  lastLocalCommunicationAt: null,
  employees: [],
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
  if (panelName === 'employees' && $('#directoryTaskPanel').classList.contains('active')) {
    loadEmployees().catch((error) => addMessage('assistant', error.message, { error: true }));
  }
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
    updateLatestLog();
  });
  source.addEventListener('device-event', (event) => {
    const payload = JSON.parse(event.data);
    state.events.push(payload);
    renderEvents();
  });
  source.addEventListener('log', (event) => {
    const payload = JSON.parse(event.data);
    state.logs.push(payload);
    updateLatestLog(payload);
    renderLogs();
  });
}

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => setPanel(button.dataset.panel));
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

$('#refreshBtn').addEventListener('click', () => {
  refreshHealth().catch((error) => addMessage('assistant', error.message));
});

$('#streamBtn').addEventListener('click', () => {
  toggleStream().catch((error) => addMessage('assistant', error.message));
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
connectSse();
refreshHealth().catch((error) => addMessage('assistant', error.message));
if ($('#employeesPanel')?.classList.contains('active') && $('#directoryTaskPanel')?.classList.contains('active')) {
  loadEmployees().catch((error) => addMessage('assistant', error.message, { error: true }));
}
