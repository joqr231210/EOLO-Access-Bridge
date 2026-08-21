const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  token: localStorage.getItem('eolo.operator.token') || '',
  userId: localStorage.getItem('eolo.operator.userId') || '',
  expiresAt: localStorage.getItem('eolo.operator.expiresAt') || '',
  operator: null,
  loginMode: 'pin',
  activeAccess: null,
  activeControlPoint: null,
  accesses: [],
  accessSource: '',
  controlPoints: [],
  controlPointSource: '',
  residents: [],
  residentCatalog: [],
  residentSource: '',
  selectedResident: null,
  movements: [],
  movementPage: 1,
  movementPageSize: 10,
  movementTotal: 0,
  streamCameras: [],
  streamCameraStatus: null,
  anprDetections: {},
  anprStatus: {},
  streamFrameHeight: Number(localStorage.getItem('eolo.operator.streamFrameHeight') || 260),
  showAnprLogs: localStorage.getItem('eolo.operator.showAnprLogs') !== 'false',
  showStreamTools: localStorage.getItem('eolo.operator.showStreamTools') !== 'false',
  streamInventorySplit: localStorage.getItem('eolo.operator.streamInventorySplit') === 'true',
  visibleStreamCameraCount: 0,
  streamCameraCollapsed: localStorage.getItem('eolo.operator.streamCameraCollapsed') === 'true',
  anprDetectionTimer: null,
  anprDetectionIntervalMs: 1000,
  selectedMovement: null,
  controlPointSelectionRequired: false,
  pendingMovements: [],
  movementKind: 'Vehiculo',
  movementType: 'Visita',
  cameras: [],
  selectedCameraId: localStorage.getItem('eolo.operator.cameraId') || '',
  settingsCameraStream: null,
  idCameraStream: null,
  idPhotoDataUrl: '',
  idPhotoUrl: '',
  vehiclePhotoDataUrl: '',
  vehicleExitPhotoDataUrl: '',
  vehiclePhotoView: 'entry',
  vehicleProfile: null,
  residentVehicleProfile: null,
  vehicleDrivers: [],
  driverOverlayOpen: false,
  companions: [],
  photoCaptureTarget: { type: 'visitor', index: -1 },
  visionConfig: null,
  cloudConfig: null,
  loadingCount: 1,
  residentInputFocused: false,
  toastCounter: 0,
  syncTimer: null,
  cloudStatusTimer: null,
  loginStatusTimer: null,
  pendingSyncTimer: null,
  residentSearchTimer: null,
  plateLookupTimer: null,
  plateLookupRequestId: 0,
  plateLookupAppliedPlate: '',
  plateLookupAppliedName: '',
  plateLookupAppliedVehicle: {},
  syncIntervalMs: 5 * 60 * 1000,
  cloudStatusIntervalMs: 60 * 1000,
  loginStatusIntervalMs: 60 * 1000
};

const VEHICLE_HISTORY_FIELDS = [
  'economic_number',
  'vehicle_type',
  'vehicle_category',
  'vehicle_year',
  'color',
  'brand',
  'model'
];

const VEHICLE_FIELD_DEFAULTS = {
  vehicle_type: 'Automovil',
  vehicle_category: 'Sedan'
};

const api = async (path, options = {}) => {
  const { silent = false, ...fetchOptions } = options;
  const headers = {
    ...(fetchOptions.body && !(fetchOptions.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(state.userId ? { 'X-EOLO-User-ID': state.userId } : {}),
    ...(state.expiresAt ? { 'X-EOLO-Expires-At': state.expiresAt } : {}),
    ...(fetchOptions.headers || {})
  };
  if (!silent) setLoading(true);
  try {
    const response = await fetch(path, { ...fetchOptions, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || response.statusText || 'Solicitud no valida');
    }
    return payload;
  } finally {
    if (!silent) setLoading(false);
  }
};

function setLoading(isLoading) {
  state.loadingCount = Math.max(0, state.loadingCount + (isLoading ? 1 : -1));
  $('#appLoader')?.classList.toggle('hidden', state.loadingCount === 0);
}

function todayKey() {
  return localDateKey(new Date());
}

function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function daysAgoKey(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
}

function formatDateLabel(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const label = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(year, month - 1, day));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function parseLocalDate(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value);
  const raw = String(value).trim();
  if (/^\d{12,}$/.test(raw)) return new Date(Number(raw));
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);
  const normalized = String(value).replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = parseLocalDate(value);
  if (!date) return 'N/A';
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function formatSyncDateTime(value) {
  const date = parseLocalDate(value);
  if (!date) return '--';
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function formatLongDate(value) {
  const date = parseLocalDate(value);
  if (!date) return 'N/A';
  const dateText = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: '2-digit',
    month: 'long'
  }).format(date);
  return dateText.charAt(0).toUpperCase() + dateText.slice(1);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function displayText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
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

function mediaUrl(value) {
  const text = displayText(value);
  if (!text) return '';
  return text.startsWith('//') ? `https:${text}` : text;
}

function setMessage(node, message, isError = true) {
  node.textContent = message || '';
  node.style.color = isError ? '#e43737' : '#2ea85d';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId)
  };
}

function showToast({ title, message = '', type = 'info', persist = false }) {
  const stack = $('#toastStack');
  if (!stack) return '';
  const id = `toast-${Date.now()}-${state.toastCounter += 1}`;
  const icon =
    type === 'loading'
      ? '<span class="toast-dots"><i></i><i></i><i></i></span>'
      : type === 'success'
        ? '✓'
        : type === 'error'
          ? '!'
          : 'i';
  stack.insertAdjacentHTML(
    'beforeend',
    `<section class="toast ${escapeHtml(type)}" id="${id}">
      <div class="toast-icon">${icon}</div>
      <div>
        <strong>${escapeHtml(title)}</strong>
        ${message ? `<span>${escapeHtml(message)}</span>` : ''}
      </div>
    </section>`
  );
  if (!persist) setTimeout(() => dismissToast(id), type === 'error' ? 5200 : 3200);
  return id;
}

function dismissToast(id) {
  if (!id) return;
  $(`#${CSS.escape(id)}`)?.remove();
}

async function restoreSession() {
  try {
    if (!state.token || !state.userId) {
      showLogin();
      return;
    }
    if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
      clearStoredSession();
      showLogin();
      return;
    }
    const session = await api('/api/operator/session');
    if (!session.authenticated) throw new Error('Sesion expirada');
    state.operator = session.operator;
    state.userId = session.userId || state.userId;
    state.expiresAt = session.expiresAt || state.expiresAt;
    state.syncIntervalMs = session.syncIntervalMs || state.syncIntervalMs;
    showOperator();
    await loadOperatorVisionConfig().catch(() => {});
    startCloudStatusTimer();
    await loadAccesses();
  } catch (_error) {
    clearStoredSession();
    showLogin();
  } finally {
    setLoading(false);
  }
}

function showLogin(options = {}) {
  if (options.resetForm) resetLoginForm();
  $('#loginScreen').classList.remove('hidden');
  $('#operatorShell').classList.add('hidden');
  startLoginStatusTimer();
}

function showOperator() {
  stopLoginStatusTimer();
  $('#loginScreen').classList.add('hidden');
  $('#operatorShell').classList.remove('hidden');
  $('#dateLabel').textContent = formatDateLabel(todayKey());
  renderOperatorProfile();
  renderActiveAccessSidebar();
}

function resetLoginForm() {
  const form = $('#loginForm');
  if (!form) return;
  form.reset();
  if (form.elements.phone) form.elements.phone.value = '';
  if (form.elements.pin) form.elements.pin.value = '';
  form.classList.remove('authenticating');
  $('#loginSubmitBtn').disabled = false;
  setMessage($('#loginMessage'), '');
  updatePinSegments();
}

function setLoginSignal(selector, status, label, detail = '') {
  const node = $(selector);
  if (!node) return;
  node.classList.remove('online', 'offline', 'unknown', 'checking');
  node.classList.add(status);
  const text = node.querySelector('[data-login-signal-text]');
  if (text) text.textContent = label;
  node.title = detail || label;
}

async function refreshLoginSignals() {
  setLoginSignal('#loginBridgeSignal', 'checking', 'Bridge local', 'Consultando Bridge local...');
  setLoginSignal('#loginCloudSignal', 'checking', 'EOLO Cloud', 'Consultando EOLO Cloud...');
  setLoginSignal('#loginAnprSignal', 'checking', 'ANPR', 'Consultando API ANPR...');
  try {
    const result = await api('/api/operator/login-status', { silent: true });
    setLoginSignal(
      '#loginBridgeSignal',
      'online',
      'Bridge local',
      `Bridge local activo · ${result.checkedAt || 'sin fecha'}`
    );
    setLoginSignal(
      '#loginCloudSignal',
      result.cloud?.online ? 'online' : 'offline',
      'EOLO Cloud',
      result.cloud?.online
        ? `EOLO Cloud activo · ${result.cloud.latencyMs || 0} ms`
        : result.cloud?.error || 'EOLO Cloud no disponible'
    );
    setLoginSignal(
      '#loginAnprSignal',
      result.anpr?.online ? 'online' : 'offline',
      'ANPR',
      result.anpr?.online ? `ANPR activo · ${result.anpr.latencyMs || 0} ms` : result.anpr?.error || 'ANPR no disponible'
    );
  } catch (error) {
    setLoginSignal('#loginBridgeSignal', 'offline', 'Bridge local', error.message);
    setLoginSignal('#loginCloudSignal', 'offline', 'EOLO Cloud', 'No se pudo consultar desde el Bridge local');
    setLoginSignal('#loginAnprSignal', 'offline', 'ANPR', 'No se pudo consultar desde el Bridge local');
  }
}

function startLoginStatusTimer() {
  stopLoginStatusTimer();
  refreshLoginSignals().catch(() => {});
  state.loginStatusTimer = setInterval(() => refreshLoginSignals().catch(() => {}), state.loginStatusIntervalMs);
}

function stopLoginStatusTimer() {
  if (state.loginStatusTimer) clearInterval(state.loginStatusTimer);
  state.loginStatusTimer = null;
}

function updatePinSegments() {
  const input = $('#loginForm')?.elements?.pin;
  const segments = $$('[data-pin-segment]');
  if (!input || !segments.length) return;
  const value = String(input.value || '').replace(/\D/g, '').slice(0, 4);
  if (input.value !== value) input.value = value;
  segments.forEach((segment, index) => {
    segment.classList.toggle('filled', index < value.length);
    segment.classList.toggle('active', document.activeElement === input && index === Math.min(value.length, 3));
  });
}

function initPinSegments() {
  const input = $('#loginForm')?.elements?.pin;
  const wrapper = $('[data-pin-ui]');
  if (!input || !wrapper) return;
  const focusPin = () => {
    input.focus();
    updatePinSegments();
  };
  wrapper.addEventListener('click', focusPin);
  input.addEventListener('input', updatePinSegments);
  input.addEventListener('focus', updatePinSegments);
  input.addEventListener('blur', updatePinSegments);
  input.addEventListener('paste', () => requestAnimationFrame(updatePinSegments));
  updatePinSegments();
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = $('#loginSubmitBtn');
  const data = Object.fromEntries(new FormData(form).entries());
  setMessage($('#loginMessage'), '');
  form.classList.add('authenticating');
  submitButton.disabled = true;
  const entranceDelay = delay(720);
  try {
    const result = await api('/api/operator/login', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'pin',
        phone: data.phone,
        pin: data.pin,
        code: ''
      })
    });
    await entranceDelay;
    state.token = result.token;
    state.userId = result.userId || '';
    state.expiresAt = result.expiresAt || '';
    state.operator = result.operator;
    state.syncIntervalMs = result.syncIntervalMs || state.syncIntervalMs;
    localStorage.setItem('eolo.operator.token', state.token);
    localStorage.setItem('eolo.operator.userId', state.userId);
    if (state.expiresAt) localStorage.setItem('eolo.operator.expiresAt', state.expiresAt);
    else localStorage.removeItem('eolo.operator.expiresAt');
    showOperator();
    await loadOperatorVisionConfig().catch(() => {});
    startCloudStatusTimer();
    await loadAccesses();
  } catch (error) {
    await entranceDelay;
    setMessage($('#loginMessage'), error.message);
  } finally {
    form.classList.remove('authenticating');
    submitButton.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/operator/logout', { method: 'POST' });
  } catch (_error) {
    // La salida local debe continuar aunque el Bridge ya haya olvidado la sesion.
  }
  clearStoredSession();
  state.operator = null;
  state.activeAccess = null;
  state.activeControlPoint = null;
  state.accesses = [];
  state.controlPoints = [];
  stopAutoSync();
  stopPendingSyncTimer();
  stopCloudStatusTimer();
  stopAnprDetectionTimer();
  showLogin({ resetForm: true });
}

function clearStoredSession() {
  localStorage.removeItem('eolo.operator.token');
  localStorage.removeItem('eolo.operator.userId');
  localStorage.removeItem('eolo.operator.expiresAt');
  state.token = '';
  state.userId = '';
  state.expiresAt = '';
}

async function loadAccesses() {
  const result = await api('/api/operator/accesses');
  state.accesses = result.accesses || [];
  state.accessSource = result.source || '';
  state.activeAccess = null;
  state.activeControlPoint = null;
  state.controlPoints = [];
  state.controlPointSource = '';
  state.residents = [];
  state.residentCatalog = [];
  state.residentSource = '';
  state.selectedResident = null;
  state.pendingMovements = [];
  renderAccesses();
  renderPendingMovements();
  showAccessPicker();
}

function renderAccesses() {
  $('#accessSourceState').textContent =
    state.accessSource === 'cloud' ? 'EOLO Cloud' : state.accessSource || 'Local';
  $('#accessPickerGrid').innerHTML = state.accesses
    .map(
      (access, index) => {
        const logo = mediaUrl(access.logo);
        const initials = displayText(access.name, 'A')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase();
        return `
        <button class="access-card" type="button" data-access-index="${index}">
          <span class="access-card-media">
            ${
              logo
                ? `<img src="${escapeHtml(logo)}" alt="" loading="lazy" />`
                : `<b>${escapeHtml(initials || 'A')}</b>`
            }
          </span>
          <div>
            <span class="access-card-title-icon"><svg class="ui-icon" aria-hidden="true"><use href="#icon-home"></use></svg></span>
            <strong>${escapeHtml(access.name || 'Acceso')}</strong>
            <p>${escapeHtml(access.description || access.location || access.company || 'Acceso autorizado')}</p>
          </div>
          <div class="access-meta">
            ${access.company ? `<span>${escapeHtml(access.company)}</span>` : ''}
            ${access.location ? `<span>${escapeHtml(access.location)}</span>` : ''}
            ${access.role ? `<span>${escapeHtml(access.role)}</span>` : ''}
          </div>
        </button>
      `;
      }
    )
    .join('');
  $('#accessEmptyState').hidden = state.accesses.length > 0;
  renderActiveAccessSidebar();
}

function renderActiveAccessSidebar() {
  const accessName = state.activeAccess?.name || 'Selecciona acceso';
  const accessLogo = mediaUrl(state.activeAccess?.logo);
  $('#companyName').textContent = accessName;
  $('#activeAccessName').textContent = accessName;
  if (accessLogo) $('#activeAccessLogo').src = accessLogo;
  else $('#activeAccessLogo').removeAttribute('src');
  $('#activeAccessLogo').classList.toggle('hidden', !accessLogo);
  $('#activeAccessLogoFallback').classList.toggle('hidden', Boolean(accessLogo));
  $('#activeControlPointName').textContent =
    state.activeControlPoint?.name || 'Selecciona punto de control';
  $('#activeControlPointMeta').textContent = state.activeControlPoint
    ? state.activeControlPoint.type || state.activeControlPoint.actionType || 'Activo'
    : 'Obligatorio';
  $('#activeAccessHint').textContent = state.activeAccess ? 'Cambiar acceso' : 'Elegir acceso';
  $('#activeControlPointHint').textContent = state.activeControlPoint ? 'Cambiar punto' : 'Elegir punto';
  $('#activeControlPointBtn').disabled = !state.activeAccess;
  $('#activeControlPointBtn').classList.toggle('active', Boolean(state.activeControlPoint));
  renderVehicleAuxIdentifierLabel();
  $$('[data-view]').forEach((button) => {
    button.disabled = !state.activeControlPoint;
  });
  const controlPointCameras = state.activeControlPoint?.cameras || [];
  const cameras = controlPointCameras.length ? controlPointCameras : state.activeAccess?.cameras || [];
  $('#accessList').innerHTML = cameras.length
    ? cameras
        .map(
          (camera, index) => `
            <label>
              <input type="checkbox" ${index === 0 ? 'checked' : ''} />
              ${escapeHtml(displayText(camera.name, 'Camara'))} ${camera.type ? `<span class="subtle">${escapeHtml(displayText(camera.type))}</span>` : ''}
            </label>
          `
        )
        .join('')
    : `
      <label><input type="checkbox" checked /> Butique</label>
      <label><input type="checkbox" /> Recepción</label>
      <label><input type="checkbox" /> Caseta de Renta</label>
      <label><input type="checkbox" checked /> Caseta Periférico</label>
    `;
}

function vehicleAuxIdentifierLabel() {
  return displayText(
    state.activeAccess?.vehicleAuxIdentifierLabel ||
      state.activeAccess?.identificadorauxiliarvehicular_text ||
      state.activeAccess?.raw?.identificadorauxiliarvehicular_text ||
      state.activeAccess?.raw?.IdentificadorAuxiliarVehicular ||
      '',
    'Número Económico'
  );
}

function renderVehicleAuxIdentifierLabel() {
  const label = vehicleAuxIdentifierLabel();
  const labelNode = $('#vehicleAuxIdentifierLabel');
  if (labelNode) labelNode.textContent = label;
  const form = $('#movementForm');
  const input = form?.elements?.economic_number;
  if (input) input.placeholder = label === 'Número Económico' ? 'N. Económico Vehículo' : label;
}

function renderOperatorProfile() {
  const operatorName = state.operator?.name || 'Operador EOLO';
  const operatorPhone = state.operator?.phone || '';
  const avatar = mediaUrl(state.operator?.avatar);
  $$('.profile-name').forEach((node) => {
    node.textContent = operatorName;
  });
  $$('.profile-phone').forEach((node) => {
    node.textContent = operatorPhone;
  });
  $$('.user-avatar-img').forEach((image) => {
    if (avatar) image.src = avatar;
    else image.removeAttribute('src');
    image.classList.toggle('hidden', !avatar);
  });
}

async function selectAccess(index) {
  state.activeAccess = state.accesses[index] || null;
  state.activeControlPoint = null;
  state.controlPoints = [];
  state.residents = [];
  state.residentCatalog = [];
  state.residentSource = '';
  state.selectedResident = null;
  state.pendingMovements = [];
  renderPendingMovements();
  renderActiveAccessSidebar();
  if (!state.activeAccess) return showAccessPicker();
  await loadControlPoints();
  showMovementsShell();
  openControlPointDialog({ required: true });
}

function showAccessPicker(options = {}) {
  stopSettingsCamera();
  stopIdCamera();
  stopAnprDetectionTimer();
  if (options.clearControlPoint) {
    state.activeControlPoint = null;
    state.controlPoints = [];
    state.controlPointSource = '';
  }
  stopAutoSync();
  stopPendingSyncTimer();
  $('#accessPickerView').classList.remove('hidden');
  $('#controlPointPickerView').classList.add('hidden');
  $('#movementsView').classList.add('hidden');
  $('#settingsView').classList.add('hidden');
  renderActiveAccessSidebar();
}

function showControlPointPicker() {
  stopSettingsCamera();
  stopIdCamera();
  stopAnprDetectionTimer();
  stopAutoSync();
  stopPendingSyncTimer();
  $('#accessPickerView').classList.add('hidden');
  $('#controlPointPickerView').classList.remove('hidden');
  $('#movementsView').classList.add('hidden');
  $('#settingsView').classList.add('hidden');
  $('#controlPointAccessName').textContent = state.activeAccess?.name || 'Selecciona acceso';
  renderActiveAccessSidebar();
}

function showMovementsShell() {
  stopSettingsCamera();
  $('#accessPickerView').classList.add('hidden');
  $('#controlPointPickerView').classList.add('hidden');
  $('#movementsView').classList.remove('hidden');
  $('#settingsView').classList.add('hidden');
  setActiveNav('movements');
  renderActiveAccessSidebar();
}

function showMovements() {
  stopSettingsCamera();
  showMovementsShell();
  startAnprDetectionTimer();
}

function showSettings() {
  stopIdCamera();
  stopAnprDetectionTimer();
  $('#accessPickerView').classList.add('hidden');
  $('#controlPointPickerView').classList.add('hidden');
  $('#movementsView').classList.add('hidden');
  $('#settingsView').classList.remove('hidden');
  setActiveNav('settings');
  renderActiveAccessSidebar();
  setOperatorSettingsTab('camera');
  loadCameras().catch((error) => showToast({ type: 'error', title: 'Cámaras no disponibles', message: error.message }));
  loadOperatorVisionConfig().catch((error) => setMessage($('#visionConfigMessage'), error.message));
  loadOperatorCloudConfig().catch((error) => setMessage($('#cloudConfigMessage'), error.message));
}

function setActiveNav(view) {
  $$('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
}

async function loadControlPoints() {
  if (!state.activeAccess?.id) return;
  $('#controlPointSourceState').textContent = 'Consultando EOLO';
  const query = new URLSearchParams({ access: state.activeAccess.id });
  const result = await api(`/api/operator/control-points?${query.toString()}`);
  state.controlPoints = result.controlPoints || result.control_points || [];
  state.controlPointSource = result.source || '';
  renderControlPoints();
  showControlPointPicker();
}

function controlPointLabel(point) {
  return displayText(point.name || point.orientation || point.Nombre || point.entryCamera, 'Punto de control');
}

function controlPointMeta(point) {
  return [point.type, point.actionType, point.requestType].map((value) => displayText(value)).filter(Boolean).join(' · ');
}

function controlPointActionMode(point = state.activeControlPoint) {
  if (point?.actionMode) return point.actionMode;
  const action = displayText(point?.actionType || point?.raw?.['Tipo Accion'] || point?.raw?.tipo_accion);
  if (/autor/i.test(action) || /solicit/i.test(action)) return 'authorize';
  if (/notific/i.test(action)) return 'notify';
  if (/registr/i.test(action)) return 'register';
  return 'register';
}

function controlPointActionLabel(point = state.activeControlPoint) {
  const mode = controlPointActionMode(point);
  if (mode === 'authorize') return 'Requiere autorización';
  if (mode === 'notify') return 'Notifica al residente';
  return 'Solo registra';
}

function controlPointSettingChips(point) {
  return [
    ['Tipo', point.type],
    ['Acción', point.actionType || controlPointActionLabel(point)],
    ['Solicitud', point.requestType],
    ['Anillo', point.ringLevel],
    ['Inspección', point.hideInspection ? 'Oculta' : 'Visible']
  ]
    .filter(([, value]) => displayText(value))
    .map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(displayText(value))}</span>`)
    .join('');
}

function controlPointCard(point, index) {
  const meta = controlPointMeta(point);
  const details = displayText(
    point.address || point.phone || point.entryCamera || point.exitCamera || point.ringLevel,
    'Punto autorizado'
  );
  return `
    <button class="control-point-card" type="button" data-control-point-index="${index}">
      <span class="control-point-marker"><svg class="ui-icon" aria-hidden="true"><use href="#icon-map-pin"></use></svg></span>
      <div>
        <strong>${escapeHtml(controlPointLabel(point))}</strong>
        <p>${escapeHtml(details)}</p>
      </div>
      <div class="access-meta">
        ${meta ? `<span>${escapeHtml(meta)}</span>` : ''}
        ${point.entryCamera ? `<span>Entrada ${escapeHtml(displayText(point.entryCamera))}</span>` : ''}
        ${point.exitCamera ? `<span>Salida ${escapeHtml(displayText(point.exitCamera))}</span>` : ''}
      </div>
      <div class="control-point-settings">
        ${controlPointSettingChips(point)}
      </div>
    </button>
  `;
}

function renderControlPoints() {
  $('#controlPointSourceState').textContent =
    state.controlPointSource === 'cloud' ? 'EOLO Cloud' : state.controlPointSource || 'Local';
  $('#controlPointAccessName').textContent = state.activeAccess?.name || 'Selecciona acceso';
  $('#controlPointPickerGrid').innerHTML = state.controlPoints.map(controlPointCard).join('');
  $('#controlPointDialogGrid').innerHTML = state.controlPoints.map(controlPointCard).join('');
  $('#controlPointEmptyState').hidden = state.controlPoints.length > 0;
  renderActiveAccessSidebar();
}

async function selectControlPoint(index) {
  state.activeControlPoint = state.controlPoints[index] || null;
  if (!state.activeControlPoint) return;
  state.controlPointSelectionRequired = false;
  if ($('#controlPointDialog').open) $('#controlPointDialog').close();
  renderActiveAccessSidebar();
  showMovements();
  await loadResidents();
  await loadStreamCameras();
  await loadMovements();
  await loadPendingMovements();
  startAutoSync();
  startPendingSyncTimer();
}

function openControlPointDialog(options = {}) {
  if (!state.activeAccess) return;
  renderControlPoints();
  $('#controlPointDialogMeta').textContent = 'Selecciona el punto de control donde te encuentras';
  state.controlPointSelectionRequired = Boolean(options.required && !state.activeControlPoint);
  $('#closeControlPointDialogBtn').hidden = state.controlPointSelectionRequired;
  $('#controlPointDialog').showModal();
}

async function loadMovements() {
  const query = new URLSearchParams({
    date_from: daysAgoKey(30),
    date_to: new Date().toISOString(),
    limit: String(state.movementPageSize),
    offset: String((state.movementPage - 1) * state.movementPageSize),
    sort: 'modified_desc'
  });
  if (state.activeAccess?.id) query.set('access', state.activeAccess.id);
  if (state.activeControlPoint?.id) query.set('control_point', state.activeControlPoint.id);
  const search = $('#movementSearch').value.trim();
  const status = $('#statusFilter').value;
  renderMovementFilterState();
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  const result = await api(`/api/operator/movements?${query.toString()}`);
  state.movements = result.movements || [];
  state.movementTotal = Number(result.total ?? result.count ?? state.movements.length) || 0;
  renderMovements(result.summary || {});
  renderMovementPagination();
  $('#syncState').textContent = `Ult. Sinc. ${formatSyncDateTime(new Date().toISOString())}`;
}

async function loadStreamCameras() {
  const summary = $('#streamCameraSummary');
  const grid = $('#streamCameraGrid');
  if (!summary || !grid) return;
  summary.textContent = 'Consultando cámaras...';
  grid.innerHTML = '';
  try {
    const result = await api('/api/operator/stream-cameras');
    state.streamCameras = result.cameras || [];
    state.streamCameraStatus = result.stream || null;
    renderStreamCameras();
    refreshAnprDetections().catch(() => {});
  } catch (error) {
    state.streamCameras = [];
    state.streamCameraStatus = { running: false, status: 'error' };
    state.visibleStreamCameraCount = 0;
    syncStreamPreferences();
    summary.textContent = `No se pudo consultar el visualizador: ${error.message}`;
    grid.innerHTML = `
      <article class="stream-camera-empty">
        <strong>Sin vista disponible</strong>
        <span>Revisa que el servicio ANPR esté activo y que haya cámaras configuradas.</span>
      </article>
    `;
  }
}

function streamCameraAllowedNames() {
  const names = new Set();
  const collect = (camera) => {
    if (typeof camera === 'string' && camera.trim()) names.add(camera.trim());
    if (camera?.name) names.add(String(camera.name).trim());
  };
  (state.activeControlPoint?.cameras || []).forEach(collect);
  (state.activeAccess?.cameras || []).forEach(collect);
  if (state.activeControlPoint?.entryCamera) names.add(String(state.activeControlPoint.entryCamera).trim());
  if (state.activeControlPoint?.exitCamera) names.add(String(state.activeControlPoint.exitCamera).trim());
  return names;
}

function renderStreamCameras() {
  const summary = $('#streamCameraSummary');
  const grid = $('#streamCameraGrid');
  if (!summary || !grid) return;
  const allowedNames = streamCameraAllowedNames();
  const allCameras = state.streamCameras || [];
  const matchingCameras = allowedNames.size
    ? allCameras.filter((camera) => allowedNames.has(camera.name))
    : allCameras;
  const cameras = matchingCameras.length ? matchingCameras : allCameras;
  const running = Boolean(state.streamCameraStatus?.running);
  state.visibleStreamCameraCount = cameras.length;
  syncStreamPreferences();
  summary.textContent = cameras.length
    ? ''
    : 'No hay cámaras configuradas para este punto.';
  grid.innerHTML = cameras.length
    ? cameras.map((camera) => renderStreamCameraCard(camera, running)).join('')
    : `
      <article class="stream-camera-empty">
        <strong>Sin cámaras</strong>
        <span>Agrega cámaras en Ajustes o selecciona un punto de control con cámaras vinculadas.</span>
      </article>
    `;
  syncStreamPreferences();
}

function syncStreamPreferences() {
  const panel = $('#streamCameraPanel');
  const layout = $('#cameraInventoryLayout');
  const collapseButton = $('#streamCameraCollapseBtn');
  const singleCamera = state.visibleStreamCameraCount === 1;
  const height = Math.min(560, Math.max(180, Number(state.streamFrameHeight) || 260));
  state.streamFrameHeight = height;
  panel?.style.setProperty('--stream-frame-height', `${height}px`);
  panel?.classList.toggle('hide-anpr-logs', !state.showAnprLogs);
  panel?.classList.toggle('hide-stream-tools', !state.showStreamTools);
  panel?.classList.toggle('stream-collapsed', state.streamCameraCollapsed);
  layout?.classList.toggle('single-camera-split', Boolean(singleCamera && state.streamInventorySplit && !state.streamCameraCollapsed));
  $$('.stream-frame-height-range').forEach((input) => {
    input.value = String(height);
  });
  $$('.stream-frame-height-value').forEach((node) => {
    node.textContent = `${height}px`;
  });
  $$('.anpr-log-toggle').forEach((input) => {
    input.checked = state.showAnprLogs;
  });
  $$('.stream-preview-toggle').forEach((input) => {
    input.checked = Boolean(state.streamCameraStatus?.running);
    input.disabled = false;
  });
  $$('.stream-tools-toggle').forEach((button) => {
    button.setAttribute('aria-expanded', String(state.showStreamTools));
    button.setAttribute(
      'aria-label',
      state.showStreamTools ? 'Ocultar controles y logs ANPR' : 'Mostrar controles y logs ANPR'
    );
    button.classList.toggle('active', state.showStreamTools);
  });
  $$('.stream-layout-toggle').forEach((button) => {
    button.classList.toggle('hidden', !singleCamera);
    button.classList.toggle('active', Boolean(singleCamera && state.streamInventorySplit));
    button.setAttribute('aria-pressed', String(Boolean(singleCamera && state.streamInventorySplit)));
    button.setAttribute(
      'aria-label',
      state.streamInventorySplit ? 'Mostrar cámara e inventario en filas' : 'Mostrar cámara e inventario en columnas'
    );
  });
  if (collapseButton) {
    collapseButton.setAttribute('aria-expanded', String(!state.streamCameraCollapsed));
    collapseButton.setAttribute(
      'aria-label',
      state.streamCameraCollapsed ? 'Mostrar visualizador de cámaras' : 'Ocultar visualizador de cámaras'
    );
  }
}

function renderStreamCameraCard(camera, running) {
  return `
    <article class="stream-camera-card">
      <div class="stream-camera-frame">
        ${
          running
            ? `<iframe title="Vista ${escapeHtml(camera.name)}" src="${escapeHtml(camera.playerUrl)}" loading="lazy"></iframe>`
            : '<div class="stream-camera-placeholder">Visualizador inactivo</div>'
        }
        <div class="stream-camera-label">
          <strong>${escapeHtml(camera.name)}</strong>
          <span>${escapeHtml(camera.type || 'Camara')}</span>
        </div>
        <button class="anpr-plate-overlay hidden" type="button" data-anpr-plate="${escapeHtml(camera.name)}" title="Usar esta placa y fotografia">
          <span>PLACA LEIDA</span>
          <strong>---</strong>
        </button>
      </div>
      <div class="stream-camera-tools">
        <div class="anpr-engine-status" data-anpr-status="${escapeHtml(camera.name)}">ANPR sin lectura todavía</div>
      </div>
    </article>
  `;
}

async function toggleStreamPreview(enabled) {
  $$('.stream-preview-toggle').forEach((input) => {
    input.disabled = true;
  });
  $('#streamCameraSummary').textContent = enabled ? 'Activando visualizador...' : 'Deteniendo visualizador...';
  try {
    await api(`/api/operator/stream-cameras/${enabled ? 'start' : 'stop'}`, { method: 'POST' });
    await loadStreamCameras();
  } catch (error) {
    showToast({
      type: 'error',
      title: enabled ? 'No se pudo activar el visualizador' : 'No se pudo detener el visualizador',
      message: error.message
    });
    await loadStreamCameras().catch(() => {});
  } finally {
    $$('.stream-preview-toggle').forEach((input) => {
      input.disabled = false;
    });
  }
}

function updateStreamFrameHeight(value) {
  state.streamFrameHeight = Math.min(560, Math.max(180, Number(value) || 260));
  localStorage.setItem('eolo.operator.streamFrameHeight', String(state.streamFrameHeight));
  syncStreamPreferences();
}

function updateAnprLogVisibility(value) {
  state.showAnprLogs = Boolean(value);
  localStorage.setItem('eolo.operator.showAnprLogs', String(state.showAnprLogs));
  syncStreamPreferences();
}

function toggleStreamCameraPanel() {
  state.streamCameraCollapsed = !state.streamCameraCollapsed;
  localStorage.setItem('eolo.operator.streamCameraCollapsed', String(state.streamCameraCollapsed));
  syncStreamPreferences();
}

function toggleStreamTools() {
  state.showStreamTools = !state.showStreamTools;
  localStorage.setItem('eolo.operator.showStreamTools', String(state.showStreamTools));
  syncStreamPreferences();
}

function toggleStreamInventoryLayout() {
  if (state.visibleStreamCameraCount !== 1) return;
  state.streamInventorySplit = !state.streamInventorySplit;
  localStorage.setItem('eolo.operator.streamInventorySplit', String(state.streamInventorySplit));
  syncStreamPreferences();
}

async function refreshAnprDetections() {
  if (!state.token || !$('#movementsView') || $('#movementsView').classList.contains('hidden')) return;
  const [detectionsResult, statusResult] = await Promise.all([
    api('/api/operator/anpr-detections', { silent: true }),
    api('/api/operator/anpr-status', { silent: true }).catch(() => ({ cameras: {} }))
  ]);
  state.anprDetections = detectionsResult.detections || {};
  state.anprStatus = statusResult.cameras || {};
  renderAnprTelemetry();
}

function renderAnprTelemetry() {
  const now = Date.now();
  $$('[data-anpr-plate]').forEach((overlay) => {
    const cameraName = overlay.dataset.anprPlate || '';
    const detection = state.anprDetections?.[cameraName];
    const detectedAt = Number(detection?.detected_at_ms || Date.parse(detection?.detected_at || ''));
    const isFresh = detection?.plate && Number.isFinite(detectedAt) && now - detectedAt <= 30000;
    overlay.classList.toggle('hidden', !isFresh);
    if (!isFresh) return;
    overlay.querySelector('strong').textContent = detection.plate;
    overlay.querySelector('span').textContent = 'PLACA LEIDA';
  });
  $$('[data-anpr-status]').forEach((node) => {
    node.textContent = anprStatusText(state.anprStatus?.[node.dataset.anprStatus]);
  });
}

async function fetchOperatorBlob(path) {
  setLoading(true);
  try {
    const response = await fetch(path, {
      headers: {
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(state.userId ? { 'X-EOLO-User-ID': state.userId } : {}),
        ...(state.expiresAt ? { 'X-EOLO-Expires-At': state.expiresAt } : {})
      }
    });
    if (!response.ok) {
      const payload = await response.json().catch(async () => ({ error: await response.text() }));
      throw new Error(payload.error || response.statusText || 'No se pudo obtener la imagen.');
    }
    return response.blob();
  } finally {
    setLoading(false);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(blob);
  });
}

function cameraByName(cameraName) {
  const name = displayText(cameraName);
  return (
    state.streamCameras.find((camera) => displayText(camera.name) === name) ||
    state.activeControlPoint?.cameras?.find((camera) => displayText(camera.name) === name) ||
    state.activeAccess?.cameras?.find((camera) => displayText(camera.name) === name) ||
    null
  );
}

function isExitCamera(cameraName) {
  const camera = cameraByName(cameraName);
  return /salida|exit|egreso/i.test(displayText(camera?.type));
}

function isEntryCamera(cameraName) {
  const camera = cameraByName(cameraName);
  const type = displayText(camera?.type);
  return /entrada|entry|ingreso/i.test(type) || (!type && !isExitCamera(cameraName));
}

function visibleStreamCameraNames() {
  const allowedNames = new Set();
  const collect = (camera) => {
    if (typeof camera === 'string' && camera.trim()) allowedNames.add(camera.trim());
    if (camera?.name) allowedNames.add(String(camera.name).trim());
  };
  (state.activeControlPoint?.cameras || []).forEach(collect);
  (state.activeAccess?.cameras || []).forEach(collect);
  if (!allowedNames.size) {
    (state.streamCameras || []).forEach(collect);
  }
  return allowedNames;
}

function latestFreshAnprCamera({ type = 'any' } = {}) {
  if (!state.streamCameraStatus?.running) return null;
  const now = Date.now();
  const allowedNames = visibleStreamCameraNames();
  return Object.entries(state.anprDetections || {})
    .map(([cameraName, detection]) => {
      const detectedAt = Number(detection?.detected_at_ms || Date.parse(detection?.detected_at || ''));
      return {
        cameraName,
        plate: sanitizePlateValue(detection?.plate || ''),
        detectedAt
      };
    })
    .filter((item) => {
      if (!item.plate || !Number.isFinite(item.detectedAt) || now - item.detectedAt > 30000) return false;
      if (allowedNames.size && !allowedNames.has(item.cameraName)) return false;
      if (type === 'entry') return isEntryCamera(item.cameraName);
      if (type === 'exit') return isExitCamera(item.cameraName);
      return isEntryCamera(item.cameraName) || isExitCamera(item.cameraName);
    })
    .sort((a, b) => b.detectedAt - a.detectedAt)[0] || null;
}

function isIngresadoMovement(movement) {
  return /ingres/i.test(displayText(movement?.status));
}

function movementMatchesPlate(movement, plate) {
  return normalizePlateLookupValue(movement?.placa) === normalizePlateLookupValue(plate);
}

async function findIngresadoMovementByPlate(plate) {
  const normalizedPlate = normalizePlateLookupValue(plate);
  const localMovement = state.movements.find(
    (movement) => movementMatchesPlate(movement, normalizedPlate) && isIngresadoMovement(movement)
  );
  if (localMovement) return localMovement;
  const query = new URLSearchParams({
    date_from: daysAgoKey(30),
    date_to: new Date().toISOString(),
    search: normalizedPlate,
    status: 'Ingresado',
    limit: '20',
    offset: '0',
    sort: 'modified_desc'
  });
  if (state.activeAccess?.id) query.set('access', state.activeAccess.id);
  if (state.activeControlPoint?.id) query.set('control_point', state.activeControlPoint.id);
  const result = await api(`/api/operator/movements?${query.toString()}`, { silent: true });
  const movements = result.movements || [];
  return movements.find((movement) => movementMatchesPlate(movement, normalizedPlate) && isIngresadoMovement(movement)) || null;
}

async function useAnprPlateForMovement(cameraName) {
  const detection = state.anprDetections?.[cameraName];
  const plate = sanitizePlateValue(detection?.plate || '');
  if (!plate) return;
  const exitCamera = isExitCamera(cameraName);
  if ($('#movementDialog').open && state.selectedMovement && !exitCamera) {
    showToast({
      type: 'info',
      title: 'Movimiento registrado',
      message: 'Los movimientos registrados son de solo lectura. Crea uno nuevo para usar esta placa.'
    });
    return;
  }
  const blob = await fetchOperatorBlob(`/api/operator/anpr-snapshots/${encodeURIComponent(cameraName)}?t=${Date.now()}`);
  const dataUrl = await blobToDataUrl(blob);
  if (exitCamera) {
    const movement = await findIngresadoMovementByPlate(plate);
    if (!movement) {
      showToast({
        type: 'info',
        title: 'Sin ingreso activo',
        message: `No encontre un movimiento ingresado para la placa ${plate}.`
      });
      return;
    }
    openMovementDialog(movement, { focusAction: true });
    setVehiclePhoto(dataUrl, 'exit');
    showToast({
      type: 'success',
      title: 'Movimiento encontrado',
      message: `${plate} listo para registrar egreso.`
    });
    return;
  }
  if (!$('#movementDialog').open) openMovementDialog();
  state.movementKind = 'Vehiculo';
  setKindButtons();
  $('#movementForm').elements.placa.value = plate;
  sanitizePlateInput();
  setVehiclePhoto(dataUrl, 'entry');
  lookupPlateHistory(plate, { force: true }).catch(() => {});
  showToast({
    type: 'success',
    title: 'Placa capturada',
    message: `${plate} y fotografia del vehiculo listas en el movimiento.`
  });
}

function movementActionBusy() {
  return $('#movementForm')?.getAttribute('aria-busy') === 'true';
}

function shouldIgnoreEnterShortcut(event) {
  if (event.defaultPrevented || event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target;
  if (!target || target === document.body) return false;
  if (target.closest?.('#idCameraDialog, #controlPointDialog, #accessPickerView, #controlPointPickerView')) return true;
  if (target.closest?.('#residentList.open, #driverOverlay.open, .profile-dropdown')) return true;
  if (target.closest?.('textarea, [contenteditable="true"]')) return true;
  return false;
}

async function handleMovementPanelEnter(event) {
  if ($('#movementsView')?.classList.contains('hidden')) return;
  if (!state.activeControlPoint?.id) return;
  const target = event.target;
  if (target?.closest?.('input, select, button, a')) return;
  event.preventDefault();
  const detection = latestFreshAnprCamera();
  if (detection?.cameraName) {
    await useAnprPlateForMovement(detection.cameraName);
    return;
  }
  openMovementDialog(null, { focusPlate: true });
}

async function handleMovementDialogEnter(event) {
  const dialog = $('#movementDialog');
  if (!dialog?.open) return;
  if (movementActionBusy() || state.residentInputFocused || state.driverOverlayOpen) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (active?.closest?.('[data-close-dialog], #vehiclePhotoActions, #idCaptureActions, #companionsList')) {
    return;
  }
  event.preventDefault();
  const egressButton = $('#egressBtn');
  if (state.selectedMovement && !egressButton.classList.contains('hidden') && !egressButton.disabled) {
    await egressMovement();
    return;
  }
  const saveButton = $('#saveMovementBtn');
  if (!state.selectedMovement && !saveButton.disabled) {
    $('#movementForm').requestSubmit(saveButton);
  }
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (shouldIgnoreEnterShortcut(event)) return;
    if ($('#movementDialog')?.open) {
      handleMovementDialogEnter(event).catch((error) => {
        showToast({ type: 'error', title: 'No se pudo ejecutar la accion', message: error.message });
      });
      return;
    }
    handleMovementPanelEnter(event).catch((error) => {
      showToast({ type: 'error', title: 'No se pudo abrir el movimiento', message: error.message });
    });
  });
}

function anprStatusText(status) {
  if (!status) return 'ANPR esperando estado del motor';
  if (status.last_error) return `ANPR: ${status.last_error}`;
  const flags = [];
  flags.push(status.capture_running ? 'capturando' : 'sin captura');
  flags.push(status.processing_running ? 'procesando' : 'sin proceso');
  const frames = Number(status.frame_count || 0);
  const predictions = Number(status.prediction_count || 0);
  const candidates = Number(status.plate_candidate_count || 0);
  const ocr = Number(status.ocr_attempt_count || 0);
  const reads = Number(status.valid_read_count || 0);
  const rejected = Number(status.invalid_read_count || 0);
  const lastRejected = status.last_ocr_text ? ` · ultimo OCR rechazado: ${status.last_ocr_text}` : '';
  return `ANPR ${flags.join(' · ')} · ${frames} frames · ${predictions} pred. · ${candidates} cand. · ${ocr} OCR · ${reads} lect. · ${rejected} rech.${lastRejected}`;
}

function startAnprDetectionTimer() {
  stopAnprDetectionTimer();
  refreshAnprDetections().catch(() => {});
  state.anprDetectionTimer = setInterval(() => {
    refreshAnprDetections().catch(() => {});
  }, state.anprDetectionIntervalMs);
}

function stopAnprDetectionTimer() {
  if (state.anprDetectionTimer) clearInterval(state.anprDetectionTimer);
  state.anprDetectionTimer = null;
}

async function loadPendingMovements() {
  const result = await api('/api/operator/pending-movements');
  const pending = result.pending || [];
  state.pendingMovements = pending.filter((item) => {
    if (state.activeAccess?.id && item.accessId && item.accessId !== state.activeAccess.id) return false;
    if (state.activeControlPoint?.id && item.controlPointId && item.controlPointId !== state.activeControlPoint.id) return false;
    return true;
  });
  renderPendingMovements();
  return state.pendingMovements;
}

function renderPendingMovements() {
  const panel = $('#pendingSyncPanel');
  const list = $('#pendingSyncList');
  const summary = $('#pendingSyncSummary');
  if (!panel || !list || !summary) return;
  const pending = state.pendingMovements || [];
  panel.classList.toggle('hidden', pending.length === 0);
  summary.textContent = pending.length
    ? `${pending.length} registro${pending.length === 1 ? '' : 's'} esperando EOLO Cloud.`
    : 'Sin pendientes.';
  list.innerHTML = pending
    .map((item) => {
      const movement = item.movement || {};
      const nextAttempt = item.nextAttemptAt ? `Próximo intento ${formatSyncDateTime(item.nextAttemptAt)}` : 'En espera';
      const error = item.lastError ? ` · ${item.lastError}` : '';
      return `
        <article class="pending-sync-item" data-pending-id="${escapeHtml(item.id)}">
          <div>
            <strong>${escapeHtml(movement.visitor_name || 'Visitante')} · ${escapeHtml(movement.kind || 'Movimiento')}</strong>
            <span>${escapeHtml(formatSyncDateTime(item.createdAt))} · ${escapeHtml(nextAttempt)}${escapeHtml(error)}</span>
          </div>
          <b>${escapeHtml(item.hasPhoto ? 'Foto guardada' : 'Sin foto')}</b>
        </article>
      `;
    })
    .join('');
}

async function syncPendingMovements({ force = false, silent = false } = {}) {
  if (!state.token) return null;
  if (!silent) $('#pendingSyncSummary').textContent = 'Sincronizando pendientes...';
  const result = await api('/api/operator/pending-movements/sync', {
    method: 'POST',
    body: JSON.stringify({ force })
  });
  state.pendingMovements = (result.pending || []).filter((item) => {
    if (state.activeAccess?.id && item.accessId && item.accessId !== state.activeAccess.id) return false;
    if (state.activeControlPoint?.id && item.controlPointId && item.controlPointId !== state.activeControlPoint.id) return false;
    return true;
  });
  renderPendingMovements();
  if (result.synced?.length) {
    showToast({
      type: 'success',
      title: 'Pendientes sincronizados',
      message: `${result.synced.length} movimiento${result.synced.length === 1 ? '' : 's'} subido${result.synced.length === 1 ? '' : 's'}.`
    });
    await loadMovements().catch(() => {});
  } else if (!silent && result.failed?.length) {
    showToast({
      type: 'info',
      title: 'EOLO Cloud no disponible',
      message: 'Se volvera a intentar en 1 minuto.'
    });
  }
  return result;
}

function renderMovementFilterState() {
  const hasSearch = Boolean($('#movementSearch')?.value.trim());
  const hasStatus = Boolean($('#statusFilter')?.value);
  $('#movementSearchBox')?.classList.toggle('active', hasSearch);
  $('#statusFilterBox')?.classList.toggle('active', hasStatus);
  $('#clearMovementSearchBtn')?.classList.toggle('hidden', !hasSearch);
  $('#clearStatusFilterBtn')?.classList.toggle('hidden', !hasStatus);
}

function resetMovementPage() {
  state.movementPage = 1;
}

function renderMovementPagination() {
  const total = state.movementTotal;
  const start = total ? (state.movementPage - 1) * state.movementPageSize + 1 : 0;
  const end = Math.min(total, start + state.movements.length - 1);
  const totalPages = Math.max(1, Math.ceil(total / state.movementPageSize));
  $('#movementPaginationInfo').textContent = `Mostrando ${start}-${end} de ${total}`;
  $('#prevMovementsPageBtn').disabled = state.movementPage <= 1;
  $('#nextMovementsPageBtn').disabled = state.movementPage >= totalPages;
}

async function loadResidents(search = '') {
  if (!state.activeAccess?.id) return [];
  const query = new URLSearchParams({ access: state.activeAccess.id });
  if (search) query.set('search', search);
  const result = await api(`/api/operator/residents?${query.toString()}`);
  const cloudResidents = result.residents || [];
  if (!search) state.residentCatalog = cloudResidents;
  const localMatches = search ? state.residentCatalog.filter((resident) => residentMatches(resident, search)) : [];
  state.residents = mergeResidents(cloudResidents, localMatches);
  state.residentSource = result.source || '';
  renderResidentList(search);
  return state.residents;
}

function residentLabel(resident) {
  return displayText(resident?.name || resident?.Nombre || resident?.telefono, 'Residente');
}

function residentMeta(resident) {
  return [resident?.area, resident?.phone, resident?.company].map((value) => displayText(value)).filter(Boolean).join(' · ');
}

function isAreaResident(resident) {
  const value =
    resident?.isArea ??
    resident?.is_area ??
    resident?.raw?.EsArea ??
    resident?.raw?.esarea_boolean ??
    resident?.raw?.isarea_boolean ??
    resident?.raw?.is_area_boolean;
  if (typeof value === 'boolean') return value;
  return /^(true|yes|si|sí|1)$/i.test(String(value || '').trim());
}

function residentMatches(resident, search = '') {
  const needle = String(search || '').trim().toLowerCase();
  if (!needle) return true;
  return [residentLabel(resident), residentMeta(resident), resident.id]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function mergeResidents(primary = [], secondary = []) {
  const byId = new Map();
  [...primary, ...secondary].forEach((resident) => {
    if (resident?.id && !byId.has(String(resident.id))) byId.set(String(resident.id), resident);
  });
  return [...byId.values()];
}

function renderResidentList(search = '') {
  const list = $('#residentList');
  if (!list) return;
  const changeButton = $('#changeResidentBtn');
  if (changeButton) changeButton.classList.toggle('hidden', !state.selectedResident);
  const needle = String(search || '').trim().toLowerCase();
  const residents = state.residents.filter((resident) => residentMatches(resident, needle));
  const areaResidents = residents.filter(isAreaResident).slice(0, 12);
  const detailResidents = residents.filter((resident) => !isAreaResident(resident)).slice(0, 25);
  const areaRow = areaResidents.length
    ? `<div class="resident-area-row">${areaResidents.map((resident) => `
        <button class="resident-area-chip ${state.selectedResident?.id === resident.id ? 'active' : ''}" type="button" data-resident-id="${escapeHtml(resident.id)}">
          ${escapeHtml(residentLabel(resident))}
        </button>
      `).join('')}</div>`
    : '';
  const detailRows = detailResidents.map((resident) => `
    <button class="resident-option ${state.selectedResident?.id === resident.id ? 'active' : ''}" type="button" data-resident-id="${escapeHtml(resident.id)}">
      <span>
        <strong>${escapeHtml(residentLabel(resident))}</strong>
        ${residentMeta(resident) ? `<span>${escapeHtml(residentMeta(resident))}</span>` : ''}
      </span>
    </button>
  `).join('');
  list.innerHTML = `${areaRow}${detailRows}`;
  if (!residents.length && needle) {
    list.innerHTML = '<button class="resident-option" type="button" disabled><span><strong>Sin resultados</strong><span>Selecciona un residente existente.</span></span></button>';
  }
  positionResidentOverlay();
}

function positionResidentOverlay() {
  const input = $('#residentSearch');
  const list = $('#residentList');
  if (!input || !list) return;
  const rect = input.getBoundingClientRect();
  list.style.setProperty('--resident-list-left', `${rect.left}px`);
  list.style.setProperty('--resident-list-top', `${rect.bottom + 4}px`);
  list.style.setProperty('--resident-list-width', `${Math.max(rect.width, 320)}px`);
}

function openResidentOverlay() {
  state.residentInputFocused = true;
  renderResidentList($('#residentSearch').value);
  positionResidentOverlay();
  $('#residentList').classList.add('open');
}

function closeResidentOverlay() {
  state.residentInputFocused = false;
  $('#residentList').classList.remove('open');
}

function clearResidentSelection({ focus = false, loadAll = false } = {}) {
  state.selectedResident = null;
  const form = $('#movementForm');
  form.elements.resident_id.value = '';
  form.elements.resident_search.value = '';
  form.elements.visit_to.value = '';
  renderResidentList('');
  if (loadAll) loadResidents('').catch((error) => setMessage($('#movementMessage'), error.message));
  if (focus) form.elements.resident_search.focus();
}

function selectResident(resident) {
  state.selectedResident = resident || null;
  const form = $('#movementForm');
  form.elements.resident_id.value = resident?.id || '';
  form.elements.resident_search.value = resident ? residentLabel(resident) : '';
  form.elements.visit_to.value = resident ? residentLabel(resident) : '';
  if (resident?.area) setArea(resident.area);
  renderResidentList(form.elements.resident_search.value);
  closeResidentOverlay();
}

function renderResidentVehicleProfile() {
  const form = $('#movementForm');
  const profile = state.residentVehicleProfile;
  const resident = profile?.resident || null;
  const card = $('#residentAutoCard');
  const badge = $('#vehicleRegisteredBadge');
  const residentField = $('.resident-field');
  const economicInput = form?.elements?.economic_number;
  const isActiveResident = Boolean(profile?.residentRegistered && resident?.id);
  const isRegisteredVehicle = Boolean(isActiveResident && state.movementKind === 'Vehiculo');
  if (badge) badge.classList.toggle('hidden', !isRegisteredVehicle);
  if (economicInput) {
    economicInput.readOnly = isRegisteredVehicle && !state.selectedMovement;
    economicInput.classList.toggle('locked-field', economicInput.readOnly);
  }
  if (residentField) residentField.hidden = isActiveResident;
  if (form?.elements?.resident_search) form.elements.resident_search.required = !isActiveResident;
  if (form?.elements?.resident_id) form.elements.resident_id.required = !isActiveResident;
  if (!card) return;
  card.classList.toggle('hidden', !isActiveResident);
  if (!isActiveResident) return;
  $('#residentAutoName').textContent = residentLabel(resident);
  $('#residentAutoMeta').textContent = residentMeta(resident) || 'AccesoResidente asociado al vehículo';
}

function applyResidentVehicleProfile(profile = {}) {
  const residentId = displayText(profile.resident_id || profile.resident?.id || profile.resident?._id);
  const residentName = displayText(profile.resident_name || profile.resident?.name || profile.resident?.fullname_text);
  const isActiveResident = Boolean(profile.resident_registered && residentId);
  if (!isActiveResident) {
    state.residentVehicleProfile = profile.vehicle_registered_access
      ? { vehicleRegistered: true, residentRegistered: false, resident: null }
      : null;
    renderResidentVehicleProfile();
    return false;
  }
  const form = $('#movementForm');
  const resident = {
    ...(profile.resident || {}),
    id: residentId,
    name: residentName || residentId,
    area: profile.resident?.area || profile.resident?.area_text || '',
    phone: profile.resident?.phone || profile.resident?.telefono_text || '',
    company: profile.resident?.company || profile.resident?.empresa_text || ''
  };
  state.residentVehicleProfile = {
    resident,
    vehicle: profile.vehicle || {},
    previousMovementType: state.movementType === 'Residente' ? 'Visita' : state.movementType,
    vehicleRegistered: Boolean(profile.vehicle_registered_access || profile.vehicle_registered),
    residentRegistered: true
  };
  state.selectedResident = resident;
  form.elements.resident_id.value = resident.id;
  form.elements.resident_search.value = residentLabel(resident);
  form.elements.visit_to.value = residentLabel(resident);
  if (resident.area) setArea(resident.area);
  if (profile.vehicle_id && form.elements.vehicle_id) form.elements.vehicle_id.value = profile.vehicle_id;
  const economicNumber = profile.vehicle?.economic_number || profile.economic_number || '';
  if (economicNumber && form.elements.economic_number) form.elements.economic_number.value = economicNumber;
  const visitorInput = form.elements.visitor_name;
  const canReplaceName =
    !visitorInput.value.trim() ||
    (state.plateLookupAppliedName && visitorInput.value.trim() === state.plateLookupAppliedName);
  if (resident.name && canReplaceName) {
    visitorInput.value = resident.name;
    state.plateLookupAppliedName = resident.name;
  }
  state.movementType = 'Residente';
  setMovementTypeButtons();
  renderResidentVehicleProfile();
  return true;
}

function clearResidentVehicleProfile({ focus = false } = {}) {
  const profile = state.residentVehicleProfile;
  const residentName = profile?.resident ? residentLabel(profile.resident) : '';
  state.residentVehicleProfile = null;
  if (state.movementType === 'Residente') state.movementType = profile?.previousMovementType || 'Visita';
  setMovementTypeButtons();
  const form = $('#movementForm');
  if (residentName && form.elements.visitor_name?.value.trim() === residentName) {
    form.elements.visitor_name.value = '';
    state.plateLookupAppliedName = '';
  }
  renderResidentVehicleProfile();
  clearResidentSelection({ focus, loadAll: focus });
  renderResidentVehicleProfile();
}

function normalizePlateLookupValue(value) {
  return sanitizePlateValue(value);
}

function sanitizePlateValue(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sanitizePersonNameValue(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function sanitizePlateInput() {
  const input = $('#movementForm')?.elements?.placa;
  if (!input) return '';
  const sanitized = sanitizePlateValue(input.value);
  if (input.value !== sanitized) input.value = sanitized;
  return sanitized;
}

function sanitizeVisitorNameInput() {
  const input = $('#movementForm')?.elements?.visitor_name;
  if (!input) return '';
  const sanitized = sanitizePersonNameValue(input.value);
  if (input.value !== sanitized) input.value = sanitized;
  return sanitized;
}

function normalizeLookupText(value) {
  return displayText(value).trim();
}

function setVehicleDetailsState(message = 'Opcional') {
  const node = $('#vehicleDetailsState');
  if (node) node.textContent = message;
}

function setVehicleDetailsCollapsed(collapsed = true) {
  const details = $('#vehicleDetails');
  const toggle = $('#vehicleDetailsToggle');
  if (!details) return;
  details.classList.toggle('collapsed', Boolean(collapsed));
  toggle?.setAttribute('aria-expanded', String(!collapsed));
}

function setVisitorLookupState(message = '', status = '') {
  const node = $('#visitorLookupState');
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('ok', status === 'ok');
  node.classList.toggle('fail', status === 'fail');
}

function setFormFieldFromHistory(form, name, value) {
  const input = form.elements[name];
  const text = normalizeLookupText(value);
  if (!input || !text) return false;
  const previous = state.plateLookupAppliedVehicle?.[name] || '';
  const current = input.value.trim();
  const defaultValue = VEHICLE_FIELD_DEFAULTS[name] || '';
  if (current && current !== defaultValue && (!previous || current !== previous)) return false;
  if (input.tagName === 'SELECT') {
    const match = [...input.options].find(
      (option) => normalizeLookupText(option.value).toLowerCase() === text.toLowerCase() ||
        normalizeLookupText(option.textContent).toLowerCase() === text.toLowerCase()
    );
    if (!match) return false;
    input.value = match.value;
    state.plateLookupAppliedVehicle[name] = match.value;
    return true;
  }
  input.value = text;
  state.plateLookupAppliedVehicle[name] = text;
  return true;
}

function clearVehicleHistoryFields(form) {
  for (const [name, value] of Object.entries(state.plateLookupAppliedVehicle || {})) {
    const input = form.elements[name];
    if (input && input.value.trim() === value) input.value = VEHICLE_FIELD_DEFAULTS[name] || '';
  }
  state.plateLookupAppliedVehicle = {};
  setVehicleDetailsState('Opcional');
}

function clearVehicleDriverState() {
  state.vehicleProfile = null;
  state.vehicleDrivers = [];
  closeDriverOverlay();
  const button = $('#driverOverlayBtn');
  if (button) {
    button.classList.add('hidden');
    button.title = 'Conductores adicionales';
    button.setAttribute('aria-expanded', 'false');
  }
  const count = $('#driverOverlayCount');
  if (count) count.textContent = '0';
  const overlay = $('#driverOverlay');
  if (overlay) overlay.innerHTML = '';
  const form = $('#movementForm');
  if (form?.elements.vehicle_id) form.elements.vehicle_id.value = '';
  if (form?.elements.driver_id) form.elements.driver_id.value = '';
  if (form?.elements.driver_mode) form.elements.driver_mode.value = '';
}

function renderDriverPanel(profile = null) {
  const button = $('#driverOverlayBtn');
  if (!button) return;
  const vehicle = profile?.vehicle || state.vehicleProfile || {};
  const drivers = profile?.drivers || state.vehicleDrivers || [];
  const hasVehicle = Boolean(profile?.vehicle_id || vehicle.id || vehicle.placa);
  if (!hasVehicle && !drivers.length) {
    button.classList.add('hidden');
    $('#driverOverlayCount').textContent = '0';
    return;
  }
  const vehicleMeta = [
    vehicle.economic_number ? `${vehicleAuxIdentifierLabel()} ${vehicle.economic_number}` : '',
    vehicle.brand,
    vehicle.model,
    vehicle.color
  ].filter(Boolean).join(' · ');
  button.classList.remove('hidden');
  button.title = vehicleMeta || (vehicle.placa ? `Vehiculo ${vehicle.placa}` : 'Conductores asociados');
  $('#driverOverlayCount').textContent = String(Math.max(drivers.length, 1));
  if (profile?.driver_id && drivers.some((driver) => driver.id === profile.driver_id)) {
    $('#driverId').value = profile.driver_id;
  } else if (drivers.length) {
    $('#driverId').value = drivers[0].id;
  } else {
    $('#driverId').value = '';
  }
  renderDriverOverlay();
  applySelectedDriver();
}

function applySelectedDriver({ clearForNew = false } = {}) {
  const form = $('#movementForm');
  const selected = form.elements.driver_id?.value || '';
  const isNew = !selected;
  form.elements.driver_mode.value = isNew ? 'new' : 'existing';
  form.elements.vehicle_id.value = state.vehicleProfile?.id || '';
  if (isNew) {
    if (clearForNew) {
      form.elements.visitor_name.value = '';
      removeIdPhoto();
    }
    setVisitorLookupState('Vehiculo registrado. Captura un nuevo conductor para asociarlo.', 'ok');
    return;
  }
  const driver = state.vehicleDrivers.find((item) => item.id === selected);
  if (!driver) return;
  form.elements.visitor_name.value = driver.name || form.elements.visitor_name.value;
  state.plateLookupAppliedName = driver.name || '';
  if (driver.id_image && !state.idPhotoDataUrl) {
    state.idPhotoUrl = driver.id_image;
    renderIdPhoto(driver.id_image);
  }
  setVisitorLookupState(`Conductor recuperado: ${driver.name || 'registrado'}.`, 'ok');
}

function driverOverlayTitle() {
  const plate = sanitizePlateValue($('#movementForm')?.elements?.placa?.value || state.vehicleProfile?.placa || '');
  return plate
    ? `Conductores Asociados a placa "${plate}" con conductores adicionales encontrados`
    : 'Conductores asociados encontrados';
}

function renderDriverOverlay() {
  const overlay = $('#driverOverlay');
  if (!overlay) return;
  const drivers = state.vehicleDrivers || [];
  const selectedId = $('#movementForm')?.elements?.driver_id?.value || '';
  overlay.innerHTML = `
    <div class="driver-overlay-title">${escapeHtml(driverOverlayTitle())}</div>
    <div class="driver-overlay-list">
      ${drivers.map((driver) => `
        <button class="driver-option ${selectedId === driver.id ? 'active' : ''}" type="button" data-driver-id="${escapeHtml(driver.id)}">
          <span>
            <strong>${escapeHtml(driver.name || driver.phone || 'Conductor registrado')}</strong>
            ${driver.phone ? `<small>${escapeHtml(driver.phone)}</small>` : ''}
          </span>
          ${driver.id_image ? '<b>Identificación</b>' : '<b class="muted">Sin ID</b>'}
        </button>
      `).join('')}
      <button class="driver-option new-driver ${!selectedId ? 'active' : ''}" type="button" data-driver-id="">
        <span>
          <strong>Registrar nuevo conductor</strong>
          <small>Captura nombre e identificación para ligarlo al vehículo.</small>
        </span>
        <b>Nuevo</b>
      </button>
    </div>
  `;
}

function positionDriverOverlay() {
  const input = $('#visitorNameInput');
  const overlay = $('#driverOverlay');
  if (!input || !overlay) return;
  const rect = input.getBoundingClientRect();
  overlay.style.setProperty('--driver-overlay-left', `${rect.left}px`);
  overlay.style.setProperty('--driver-overlay-top', `${rect.bottom + 4}px`);
  overlay.style.setProperty('--driver-overlay-width', `${Math.max(rect.width, 320)}px`);
}

function openDriverOverlay() {
  if (!state.vehicleProfile && !state.vehicleDrivers.length) return;
  state.driverOverlayOpen = true;
  renderDriverOverlay();
  positionDriverOverlay();
  $('#driverOverlay')?.classList.add('open');
  $('#driverOverlayBtn')?.setAttribute('aria-expanded', 'true');
}

function closeDriverOverlay() {
  state.driverOverlayOpen = false;
  $('#driverOverlay')?.classList.remove('open');
  $('#driverOverlayBtn')?.setAttribute('aria-expanded', 'false');
}

function selectDriver(driverId = '') {
  const form = $('#movementForm');
  if (!form) return;
  form.elements.driver_id.value = driverId;
  applySelectedDriver({ clearForNew: !driverId });
  renderDriverOverlay();
  closeDriverOverlay();
}

function parseVehicleDescription(value) {
  const text = normalizeLookupText(value).replace(/\s+/g, ' ').trim();
  if (!text) return {};
  const parts = text.split(' ').filter(Boolean);
  return {
    vehicle_type: parts[0] || '',
    vehicle_category: parts[1] || ''
  };
}

function clearVehicleAuxIdentifierValue() {
  const form = $('#movementForm');
  const input = form?.elements?.economic_number;
  if (!input || state.selectedMovement) return;
  input.value = '';
  input.readOnly = false;
  input.classList.remove('locked-field');
}

function applyVehicleHistory(profile, { includeAuxIdentifier = false } = {}) {
  const form = $('#movementForm');
  const vehicle = {
    ...(profile?.movement || {}),
    ...(profile?.vehicle || {})
  };
  const parsedDescription = parseVehicleDescription(vehicle.vehicle_description);
  if (!vehicle.vehicle_type) vehicle.vehicle_type = parsedDescription.vehicle_type || '';
  if (!vehicle.vehicle_category) vehicle.vehicle_category = parsedDescription.vehicle_category || '';
  if (!includeAuxIdentifier) vehicle.economic_number = '';
  state.plateLookupAppliedVehicle = {};
  const applied = VEHICLE_HISTORY_FIELDS.filter((name) => setFormFieldFromHistory(form, name, vehicle[name]));
  if (!includeAuxIdentifier) clearVehicleAuxIdentifierValue();
  if (!applied.length) {
    setVehicleDetailsState('Sin historial');
    return false;
  }
  setVehicleDetailsState('Desde EOLO');
  const isVehicle = state.movementKind === 'Vehiculo';
  const vehiclePrimaryFields = $('#vehiclePrimaryFields');
  const vehicleDetails = $('#vehicleDetails');
  if (vehiclePrimaryFields) vehiclePrimaryFields.hidden = !isVehicle;
  if (vehicleDetails) vehicleDetails.hidden = !isVehicle;
  return true;
}

function resetPlateLookupState() {
  clearTimeout(state.plateLookupTimer);
  state.plateLookupTimer = null;
  state.plateLookupAppliedPlate = '';
  state.plateLookupAppliedName = '';
  state.plateLookupAppliedVehicle = {};
  state.residentVehicleProfile = null;
  if (state.movementType === 'Residente') {
    state.movementType = 'Visita';
    setMovementTypeButtons();
  }
  state.plateLookupRequestId += 1;
  renderResidentVehicleProfile();
  setVisitorLookupState('');
}

function schedulePlateHistoryLookup() {
  clearTimeout(state.plateLookupTimer);
  if (state.selectedMovement || state.movementKind !== 'Vehiculo') return;
  const form = $('#movementForm');
  const plate = normalizePlateLookupValue($('#movementForm').elements.placa?.value);
  if (state.plateLookupAppliedPlate && plate !== state.plateLookupAppliedPlate) {
    clearVehicleHistoryFields(form);
    if (state.idPhotoUrl && !state.idPhotoDataUrl) {
      state.idPhotoUrl = '';
      renderIdPhoto('');
    }
    if (state.plateLookupAppliedName && form.elements.visitor_name?.value.trim() === state.plateLookupAppliedName) {
      form.elements.visitor_name.value = '';
    }
    state.plateLookupAppliedPlate = '';
    state.plateLookupAppliedName = '';
    state.plateLookupAppliedVehicle = {};
    if (state.residentVehicleProfile) clearResidentVehicleProfile();
    clearVehicleAuxIdentifierValue();
    clearVehicleDriverState();
    renderResidentVehicleProfile();
    setVisitorLookupState('');
  }
  if (plate.length < 3 || !state.activeAccess?.id) {
    state.plateLookupAppliedPlate = '';
    state.plateLookupAppliedName = '';
    state.plateLookupAppliedVehicle = {};
    if (state.residentVehicleProfile) clearResidentVehicleProfile();
    clearVehicleAuxIdentifierValue();
    clearVehicleDriverState();
    setVehicleDetailsState('Opcional');
    renderResidentVehicleProfile();
    setVisitorLookupState('');
    return;
  }
  state.plateLookupTimer = setTimeout(() => {
    lookupPlateHistory(plate).catch(() => {});
  }, 650);
}

async function lookupPlateHistory(plateValue, { force = false } = {}) {
  if (state.selectedMovement || state.movementKind !== 'Vehiculo') return null;
  const plate = normalizePlateLookupValue(plateValue);
  if (plate.length < 3 || !state.activeAccess?.id) return null;
  const form = $('#movementForm');
  if (normalizePlateLookupValue(form.elements.placa?.value) !== plate) return null;
  if (!force && state.plateLookupAppliedPlate === plate) return null;
  const requestId = ++state.plateLookupRequestId;
  setVisitorLookupState('Consultando historial por placa...');
  let result;
  try {
    result = await api(
      `/api/operator/plate-history?access_id=${encodeURIComponent(state.activeAccess.id)}&plate=${encodeURIComponent(plate)}&_=${Date.now()}`,
      { silent: true }
    );
  } catch (error) {
    if (requestId === state.plateLookupRequestId) setVisitorLookupState('');
    return null;
  }
  if (requestId !== state.plateLookupRequestId) return null;
  if (normalizePlateLookupValue(form.elements.placa?.value) !== plate) return null;
  state.plateLookupAppliedPlate = plate;
  const profile = result?.profile || {};
  if (!result?.found || (!profile.visitor_name && !profile.id_image && !profile.vehicle)) {
    setVisitorLookupState('');
    setVehicleDetailsState('Sin historial');
    clearVehicleAuxIdentifierValue();
    clearVehicleDriverState();
    return null;
  }
  state.vehicleProfile = {
    ...(profile.vehicle || {}),
    id: profile.vehicle_id || profile.vehicle?.id || ''
  };
  state.vehicleDrivers = Array.isArray(profile.drivers) ? profile.drivers : [];
  renderDriverPanel(profile);
  const residentApplied = applyResidentVehicleProfile(profile);
  const visitorInput = form.elements.visitor_name;
  const canReplaceName =
    !visitorInput.value.trim() ||
    (state.plateLookupAppliedName && visitorInput.value.trim() === state.plateLookupAppliedName);
  if (!residentApplied && profile.visitor_name && canReplaceName) {
    visitorInput.value = profile.visitor_name;
    state.plateLookupAppliedName = profile.visitor_name;
  }
  if (profile.id_image && !state.idPhotoDataUrl) {
    state.idPhotoUrl = profile.id_image;
    renderIdPhoto(profile.id_image);
  }
  const vehicleApplied = applyVehicleHistory(profile, { includeAuxIdentifier: residentApplied });
  const parts = [];
  if (residentApplied && profile.resident_name) parts.push(`residente ${profile.resident_name}`);
  else if (profile.visitor_name) parts.push(profile.visitor_name);
  if (state.vehicleDrivers.length) parts.push(`${state.vehicleDrivers.length} conductor${state.vehicleDrivers.length === 1 ? '' : 'es'}`);
  if (profile.vehicle_registered_access) parts.push('vehiculo registrado en este acceso');
  else if (vehicleApplied) parts.push('vehiculo encontrado');
  if (profile.last_seen_at) parts.push(`ultimo acceso ${formatLongDate(profile.last_seen_at)}`);
  setVisitorLookupState(parts.length ? `Datos recuperados por placa: ${parts.join(' · ')}` : 'Datos recuperados por placa.', 'ok');
  showToast({
    type: 'success',
    title: residentApplied ? 'Residente registrado' : 'Visitante registrado',
    message: residentApplied
      ? 'El movimiento se registrara como Residente.'
      : state.vehicleDrivers.length
      ? 'Selecciona el conductor o registra uno nuevo.'
      : 'Se recuperaron datos anteriores de esta placa.'
  });
  return profile;
}

function findResidentByMovement(movement) {
  const residentId = displayText(
    movement?.resident_id ||
    movement?.resident?.id ||
    movement?.resident?._id ||
    movement?.raw?.ResidenteVisitado ||
    movement?.raw?.residente_custom_accesoresidentes
  );
  if (!residentId) return null;
  return (
    state.residentCatalog.find((resident) => String(resident.id) === residentId) ||
    state.residents.find((resident) => String(resident.id) === residentId) ||
    null
  );
}

function looksLikeBubbleUid(value) {
  const text = displayText(value);
  return /^\d{10,}x[\da-z]+$/i.test(text) || /^[a-f0-9]{24}$/i.test(text);
}

function readableResidentText(value, residentId = '') {
  const text = displayText(value);
  if (!text || text === residentId || looksLikeBubbleUid(text)) return '';
  return text;
}

function movementVisitTo(movement) {
  const resident = findResidentByMovement(movement);
  const residentId = displayText(
    movement?.resident_id ||
    movement?.resident?.id ||
    movement?.resident?._id ||
    movement?.raw?.ResidenteVisitado ||
    movement?.raw?.residente_custom_accesoresidentes
  );
  const visitTo = readableResidentText(movement?.visit_to, residentId);
  const residentText = readableResidentText(movement?.resident, residentId);
  const rawResident = movement?.raw?.ResidenteVisitado;
  return (
    (resident ? residentLabel(resident) : '') ||
    visitTo ||
    residentText ||
    readableResidentText(rawResident, residentId) ||
    'N/A'
  );
}

function movementArea(movement) {
  const resident = findResidentByMovement(movement);
  return displayText(movement?.area) || displayText(resident?.area) || displayText(resident?.company) || 'N/A';
}

function renderMovements(summary) {
  $('#vehicleInventory').textContent = summary.vehicles ?? 0;
  $('#pedestrianInventory').textContent = summary.pedestrians ?? 0;
  $('#vehicleVisitsBadge').textContent = `${summary.vehicles ?? 0} Visitas`;
  $('#pedestrianVisitsBadge').textContent = `${summary.pedestrians ?? 0} Visitas`;

  const rows = $('#movementRows');
  rows.innerHTML = state.movements
    .map(
      (movement) => `
        <tr data-movement-id="${movement.id}">
          <td>
            ${escapeHtml(movement.visitor_name || movement.telefono || 'Visitante')}
            <span class="subtle">${escapeHtml(movement.folio_display || movement.uid_bubble || movement.id)}</span>
          </td>
          <td>
            ${escapeHtml(formatTime(movement.fecha_entrada))}
            <span class="subtle">${escapeHtml(formatLongDate(movement.fecha_entrada))}</span>
          </td>
          <td>${escapeHtml(movement.movement_type || 'Visita')}</td>
          <td>
            ${escapeHtml(movement.placa || 'N/A')}
            <span class="subtle">${movement.kind === 'Peaton' ? 'PEATON' : 'VEHICULO'}</span>
          </td>
          <td>${escapeHtml(movement.notes || 'N/A')}</td>
          <td>${escapeHtml(movementVisitTo(movement))}</td>
          <td>${escapeHtml(movementArea(movement))}</td>
          <td><span class="status-pill ${movement.status.toLowerCase()}">${escapeHtml(movement.status)}</span></td>
          <td>
            ${escapeHtml(formatTime(movement.fecha_salida))}
            <span class="subtle">${escapeHtml(formatLongDate(movement.fecha_salida))}</span>
          </td>
        </tr>
      `
    )
    .join('');
  $('#emptyState').hidden = state.movements.length > 0;
}

function focusMovementPlateInput() {
  const input = $('#movementForm')?.elements?.placa;
  if (!input || input.disabled || input.readOnly) return;
  setTimeout(() => {
    input.focus();
    input.select?.();
  }, 80);
}

function focusMovementActionButton() {
  setTimeout(() => {
    const button = state.selectedMovement ? $('#egressBtn') : $('#saveMovementBtn');
    if (!button || button.disabled || button.classList.contains('hidden')) return;
    button.focus();
  }, 80);
}

function openMovementDialog(movement = null, { focusPlate = false, focusAction = false } = {}) {
  state.selectedMovement = movement;
  state.selectedResident = null;
  state.vehicleProfile = null;
  state.vehicleDrivers = [];
  state.companions = [];
  resetPlateLookupState();
  state.movementKind = movement?.kind || 'Vehiculo';
  state.movementType = movement?.movement_type || 'Visita';
  const form = $('#movementForm');
  form.reset();
  setMessage($('#movementMessage'), '');

  $('#movementModalTitle').textContent = movement ? 'Información de Movimiento' : 'Solicitud de Acceso';
  $('#movementModalMeta').textContent = movement
    ? `ID ${movement.folio_display || movement.id}`
    : 'Nuevo movimiento';
  const statusChip = $('#movementStatusChip');
  statusChip.textContent = movement?.status || '';
  statusChip.className = `status-pill modal-status ${movement?.status ? String(movement.status).toLowerCase() : 'hidden'}`;

  setKindButtons();
  setMovementTypeButtons();
  renderVehicleAuxIdentifierLabel();
  setArea(movement?.area || '');

  const values = {
    placa: movement?.placa || '',
    economic_number: movement?.economic_number || '',
    vehicle_type: movement?.vehicle_type || 'Automovil',
    vehicle_category: movement?.vehicle_category || 'Sedan',
    vehicle_year: movement?.vehicle_year || '',
    color: movement?.color || '',
    brand: movement?.brand || '',
    model: movement?.model || '',
    telefono: movement?.telefono || '',
    notes: movement?.notes || '',
    visitor_name: movement?.visitor_name || '',
    resident_search: movement ? movementVisitTo(movement) : '',
    resident_id: displayText(movement?.resident_id || movement?.resident?.id || movement?.resident?._id),
    visit_to: movement ? movementVisitTo(movement) : '',
    inspection_notes: movement?.inspection_notes || ''
  };
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements[name];
    if (input) input.value = value;
  }

  renderMovementSummary(movement);
  renderMovementHistory(movement);
  renderMovementAssets(movement);
  renderMovementDetails(movement);
  renderCompanions();
  clearVehicleDriverState();
  renderResidentVehicleProfile();
  const vehiclePrimaryFields = $('#vehiclePrimaryFields');
  if (vehiclePrimaryFields) vehiclePrimaryFields.hidden = state.movementKind !== 'Vehiculo';
  const vehicleDetails = $('#vehicleDetails');
  if (vehicleDetails) {
    vehicleDetails.hidden = state.movementKind !== 'Vehiculo';
    setVehicleDetailsCollapsed(true);
  }
  if (!movement) {
    loadResidents().catch((error) => setMessage($('#movementMessage'), error.message));
  } else {
    renderResidentList(values.resident_search);
  }
  updateMovementActions(movement);
  setMovementFieldsReadOnly(Boolean(movement));
  const canChangeIdentification = !movement;
  $$('#idCaptureActions button').forEach((button) => {
    button.disabled = !canChangeIdentification;
  });
  const hasIdentificationPhoto = Boolean(state.idPhotoDataUrl || state.idPhotoUrl || movement?.id_image);
  $('#openIdCameraBtn').classList.toggle('hidden', !canChangeIdentification || hasIdentificationPhoto);
  $('#retakeIdPhotoBtn').classList.toggle('hidden', !canChangeIdentification || !hasIdentificationPhoto);
  $('#removeIdPhotoBtn').classList.toggle('hidden', !canChangeIdentification || !hasIdentificationPhoto);
  $$('#vehiclePhotoActions button').forEach((button) => {
    button.disabled = Boolean(movement);
  });
  $('#changeVehiclePhotoFromCameraBtn').classList.toggle('hidden', Boolean(movement));
  $('#removeVehiclePhotoBtn').classList.toggle('hidden', Boolean(movement) || !state.vehiclePhotoDataUrl);
  $('#visitorIdCameraBtn').disabled = !canChangeIdentification;
  $('#driverOverlayBtn').disabled = Boolean(movement);
  updateKindFields();

  $('#movementDialog').showModal();
  positionResidentOverlay();
  if (state.driverOverlayOpen) positionDriverOverlay();
  if (focusAction) focusMovementActionButton();
  if (!movement && focusPlate) focusMovementPlateInput();
}

function setMovementFieldsReadOnly(isReadOnly) {
  const form = $('#movementForm');
  $$('input, select, textarea', form).forEach((input) => {
    input.disabled = isReadOnly;
  });
  $$('[data-kind], [data-movement-type]', form).forEach((button) => {
    button.disabled = isReadOnly;
  });
  $('#changeResidentBtn').disabled = isReadOnly;
  $('#visitorIdCameraBtn').disabled = isReadOnly;
  $('#driverOverlayBtn').disabled = isReadOnly;
}

function closeMovementDialog() {
  closeResidentOverlay();
  closeDriverOverlay();
  stopIdCamera();
  closeIdCameraDialog();
  $('#movementDialog').close();
}

function updateMovementActions(movement) {
  const saveButton = $('#saveMovementBtn');
  const egressButton = $('#egressBtn');
  const status = displayText(movement?.status);
  const canExit = Boolean(movement?.can_exit) || status === 'Ingresado';
  saveButton.classList.remove('hidden');
  egressButton.classList.toggle('hidden', !canExit);
  saveButton.disabled = false;

  if (!movement) {
    saveButton.textContent =
      controlPointActionMode(state.activeControlPoint) === 'authorize' ? 'Solicitar autorización' : 'Ingresar';
    return;
  }

  if (canExit) {
    saveButton.classList.add('hidden');
    egressButton.textContent = 'Egresar';
    return;
  }

  if (status === 'Egresado') {
    saveButton.textContent = 'Egresado';
    saveButton.disabled = true;
    return;
  }

  saveButton.textContent = status ? `Sin accion: ${status}` : 'Sin accion';
  saveButton.disabled = true;
}

function setKindButtons() {
  $$('[data-kind]').forEach((button) => {
    button.classList.toggle('active', button.dataset.kind === state.movementKind);
  });
  updateKindFields();
}

function updateKindFields() {
  const form = $('#movementForm');
  const isVehicle = state.movementKind === 'Vehiculo';
  const isReadOnly = Boolean(state.selectedMovement);
  ['placa', 'economic_number', 'vehicle_type', 'vehicle_category', 'vehicle_year', 'color', 'brand', 'model']
    .forEach((name) => {
      const input = form.elements[name];
      if (!input) return;
      input.disabled = !isVehicle || isReadOnly;
      if (name === 'placa') input.required = isVehicle;
    });
  const vehiclePrimaryFields = $('#vehiclePrimaryFields');
  if (vehiclePrimaryFields) vehiclePrimaryFields.hidden = !isVehicle;
  const vehicleDetails = $('#vehicleDetails');
  if (vehicleDetails) {
    vehicleDetails.hidden = !isVehicle;
    if (!isVehicle) setVehicleDetailsCollapsed(true);
  }
  if (!isVehicle) clearVehicleDriverState();
  renderResidentVehicleProfile();
}

function setMovementTypeButtons() {
  $$('[data-movement-type]').forEach((button) => {
    button.classList.toggle('active', button.dataset.movementType === state.movementType);
  });
}

function setArea(area) {
  $('#movementForm').elements.area.value = area;
  $$('[data-area]').forEach((button) => {
    button.classList.toggle('active', button.dataset.area === area);
  });
}

function setOperatorSettingsTab(tab = 'camera') {
  const active = tab || 'camera';
  $$('[data-operator-settings-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.operatorSettingsTab === active);
  });
  $$('[data-settings-section]').forEach((section) => {
    section.hidden = section.dataset.settingsSection !== active;
  });
}

function renderMovementSummary(movement) {
  $('#movementSummaryStrip').hidden = false;
  const entryValue = movement?.fecha_entrada || new Date().toISOString();
  $('#movementEntrySummary').textContent = `${formatTime(entryValue)} · ${formatLongDate(entryValue)}`;
  $('#movementExitSummary').textContent = movement?.fecha_salida
    ? `${formatTime(movement.fecha_salida)} · ${formatLongDate(movement.fecha_salida)}`
    : 'N/A';
  $('#movementKindSummary').textContent = movement?.kind || state.movementKind || 'Vehiculo';
}

function renderMovementHistory(movement) {
  const history = $('#movementHistory');
  if (!movement) {
    history.innerHTML = '<li><strong>Solicitud</strong> Captura en proceso</li>';
    return;
  }
  const items = [];
  items.push(
    `<li><strong>Solicitud</strong>${escapeHtml(movement.visitor_name || 'Visitante')} · ${escapeHtml(movementVisitTo(movement))}</li>`
  );
  if (movement.fecha_entrada) {
    items.push(`<li><strong>Ingreso</strong>${escapeHtml(formatLongDate(movement.fecha_entrada))} ${escapeHtml(formatTime(movement.fecha_entrada))}</li>`);
  }
  if (movement.fecha_salida) {
    items.push(`<li><strong>Egreso</strong>${escapeHtml(formatLongDate(movement.fecha_salida))} ${escapeHtml(formatTime(movement.fecha_salida))}</li>`);
  }
  history.innerHTML = items.join('');
}

function renderMovementAssets(movement) {
  state.vehiclePhotoDataUrl = '';
  state.vehicleExitPhotoDataUrl = '';
  state.vehiclePhotoView = 'entry';
  $('#vehiclePhotoDataUrl').value = '';
  $('#vehicleExitPhotoDataUrl').value = '';
  renderVehiclePhoto();
  state.idPhotoDataUrl = '';
  state.idPhotoUrl = '';
  $('#idPhotoDataUrl').value = '';
  $('#idPhotoUrl').value = '';
  setIdVisionState('');
  setVehicleDetailsState(movement ? 'Registrado' : 'Opcional');
  renderIdPhoto(movement?.id_image || '');
}

function renderCompanions() {
  const list = $('#companionsList');
  const summary = $('#companionsSummary');
  if (!list || !summary) return;
  const companions = state.companions || [];
  summary.textContent = companions.length
    ? `${companions.length} acompañante${companions.length === 1 ? '' : 's'}`
    : 'Sin acompañantes';
  list.innerHTML = companions.map((companion, index) => `
    <div class="companion-row" data-companion-index="${index}">
      <div class="asset-placeholder ${companion.photoDataUrl || companion.photoUrl ? 'has-image' : ''}">
        ${companion.photoDataUrl || companion.photoUrl
          ? `<img src="${escapeHtml(companion.photoDataUrl || companion.photoUrl)}" alt="" loading="lazy" />`
          : 'Sin foto'}
      </div>
      <input value="${escapeHtml(companion.name || '')}" placeholder="Nombre del acompañante" data-companion-name="${index}" />
      <div class="companion-actions">
        <button class="ghost" type="button" data-companion-photo="${index}">Foto</button>
        <button class="danger" type="button" data-companion-remove="${index}">Eliminar</button>
      </div>
    </div>
  `).join('');
}

function addCompanion() {
  state.companions.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: '',
    photoDataUrl: '',
    photoUrl: ''
  });
  renderCompanions();
}

function updateCompanionName(index, value) {
  const companion = state.companions[index];
  if (!companion) return;
  companion.name = value;
}

function removeCompanion(index) {
  state.companions.splice(index, 1);
  renderCompanions();
}

function renderImageSlot(slot, url) {
  if (!url) {
    slot.textContent = 'Sin Imagen';
    slot.classList.remove('has-image');
    return;
  }
  slot.classList.add('has-image');
  slot.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
}

function renderVehiclePhoto(url = '') {
  const movement = state.selectedMovement || {};
  const isExit = state.vehiclePhotoView === 'exit';
  const displayUrl = url || (
    isExit
      ? state.vehicleExitPhotoDataUrl || movement.exit_image || ''
      : state.vehiclePhotoDataUrl || movement.entry_image || ''
  );
  $$('#vehiclePhotoTabs [data-vehicle-photo-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.vehiclePhotoView === state.vehiclePhotoView);
  });
  renderImageSlot($('#vehicleImageSlot'), displayUrl);
  $('#vehiclePhotoDataUrl').value = state.vehiclePhotoDataUrl || '';
  $('#vehicleExitPhotoDataUrl').value = state.vehicleExitPhotoDataUrl || '';
  const hasEditablePhoto = isExit ? Boolean(state.vehicleExitPhotoDataUrl) : Boolean(state.vehiclePhotoDataUrl);
  $('#removeVehiclePhotoBtn').classList.toggle('hidden', !hasEditablePhoto || Boolean(state.selectedMovement));
  $('#changeVehiclePhotoFromCameraBtn').classList.toggle('hidden', Boolean(state.selectedMovement));
}

function setVehiclePhoto(dataUrl, view = state.vehiclePhotoView || 'entry') {
  state.vehiclePhotoView = view === 'exit' ? 'exit' : 'entry';
  if (state.vehiclePhotoView === 'exit') state.vehicleExitPhotoDataUrl = dataUrl || '';
  else state.vehiclePhotoDataUrl = dataUrl || '';
  renderVehiclePhoto();
}

function renderIdPhoto(url = state.idPhotoDataUrl) {
  const slot = $('#idImageSlot');
  const hasPhoto = Boolean(url);
  if (!hasPhoto) {
    slot.textContent = 'Sin Imagen';
    slot.classList.remove('has-image');
  } else {
    slot.classList.add('has-image');
    slot.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
  }
  $('#idPhotoDataUrl').value = state.idPhotoDataUrl || '';
  $('#idPhotoUrl').value = state.idPhotoUrl || '';
  $('#openIdCameraBtn').classList.toggle('hidden', hasPhoto);
  $('#retakeIdPhotoBtn').classList.toggle('hidden', !hasPhoto);
  $('#removeIdPhotoBtn').classList.toggle('hidden', !hasPhoto);
}

async function loadOperatorVisionConfig() {
  const result = await api('/api/operator/vision-config');
  state.visionConfig = result.openaiVision || {};
  renderVisionConfig();
  return state.visionConfig;
}

function renderVisionConfig() {
  if (!$('#visionEnabled')) return;
  const cfg = state.visionConfig || {};
  $('#visionEnabled').checked = Boolean(cfg.enabled);
  $('#visionModel').value = cfg.model || 'gpt-4o-mini';
  $('#visionApiKey').value = '';
  $('#changeVisionKey').checked = !cfg.apiKeySet;
  $('#changeVisionKey').disabled = !cfg.apiKeySet;
  syncVisionControls();
}

function syncVisionControls() {
  if (!$('#visionEnabled')) return;
  const cfg = state.visionConfig || {};
  const hasSavedKey = Boolean(cfg.apiKeySet);
  const changingKey = !hasSavedKey || $('#changeVisionKey').checked;
  const enabled = $('#visionEnabled').checked;
  $('#visionModel').required = enabled;
  $('#visionApiKey').disabled = !changingKey;
  $('#visionApiKey').required = enabled && changingKey;
  $('#visionApiKey').placeholder = changingKey
    ? 'API key de OpenAI'
    : 'API key guardada; activa cambiar para reemplazarla';
  $('#visionKeyHint').textContent = hasSavedKey
    ? 'La API key guardada se conserva si no activas el cambio.'
    : 'No hay API key guardada; captura una antes de activar Vision.';
}

async function saveVisionConfig() {
  setMessage($('#visionConfigMessage'), '');
  const cfg = state.visionConfig || {};
  const hasSavedKey = Boolean(cfg.apiKeySet);
  const shouldChangeKey = !hasSavedKey || $('#changeVisionKey').checked;
  const payload = {
    enabled: $('#visionEnabled').checked,
    model: $('#visionModel').value.trim() || 'gpt-4o-mini',
    apiKey: shouldChangeKey ? $('#visionApiKey').value.trim() : ''
  };
  const result = await api('/api/operator/vision-config', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  state.visionConfig = result.openaiVision || {};
  renderVisionConfig();
  setMessage($('#visionConfigMessage'), 'Configuracion guardada.', false);
  showToast({ type: 'success', title: 'OpenAI Vision actualizado' });
}

async function loadOperatorCloudConfig() {
  const result = await api('/api/operator/cloud-config');
  state.cloudConfig = result.operator || {};
  renderCloudConfig();
  return state.cloudConfig;
}

function renderCloudConfig() {
  if (!$('#cloudBranchPreset')) return;
  const cfg = state.cloudConfig || {};
  const version = String(cfg.appVersion || 'live').replace(/^version-/, '');
  const preset = ['live', 'test', '13i8l', '73hi5'].includes(version) ? version : 'custom';
  $('#cloudBranchPreset').value = preset;
  $('#cloudBranchCustom').value = preset === 'custom' ? version : '';
  $('#cloudBaseUrl').value = cfg.appBaseUrl || 'https://eolo.app';
  $('#cloudDeviceHeartbeatEnabled').checked = cfg.deviceHeartbeatEnabled !== false;
  $('#cloudDeviceId').value = cfg.deviceId || cfg.effectiveDeviceId || '';
  $('#cloudDeviceHeartbeatEndpoint').value = cfg.deviceHeartbeatEndpoint || 'bridge_operator_device_heartbeat';
  $('#cloudDeviceDataType').value = cfg.deviceDataType || 'dispositivosacceso';
  $('#cloudWorkflowUrl').textContent = cfg.workflowBaseUrl || 'Sin consultar';
  $('#cloudHeartbeatWorkflowUrl').textContent = cfg.deviceHeartbeatWorkflowUrl || 'Sin consultar';
  $('#cloudEffectiveDeviceId').textContent = cfg.effectiveDeviceId || cfg.deviceId || 'Sin consultar';
  syncCloudControls();
}

function syncCloudControls() {
  if (!$('#cloudBranchPreset')) return;
  const isCustom = $('#cloudBranchPreset').value === 'custom';
  $('#cloudBranchCustomLabel').hidden = !isCustom;
  $('#cloudBranchCustom').disabled = !isCustom;
  $('#cloudBranchCustom').required = isCustom;
  $('#cloudBranchCustom').placeholder = 'Test';
  $('#cloudDeviceHeartbeatEndpoint').readOnly = true;
  $('#cloudDeviceDataType').readOnly = true;
}

function normalizedBranchValue(value = '') {
  return String(value || 'live').trim().replace(/^version-/, '') || 'live';
}

async function saveCloudConfig() {
  setMessage($('#cloudConfigMessage'), '');
  const previousBaseUrl = String(state.cloudConfig?.appBaseUrl || 'https://eolo.app').trim();
  const previousVersion = normalizedBranchValue(state.cloudConfig?.appVersion);
  const preset = $('#cloudBranchPreset').value;
  const appVersion = preset === 'custom' ? $('#cloudBranchCustom').value.trim() : preset;
  const payload = {
    appBaseUrl: $('#cloudBaseUrl').value.trim() || 'https://eolo.app',
    appVersion,
    deviceHeartbeatEnabled: $('#cloudDeviceHeartbeatEnabled').checked,
    deviceId: $('#cloudDeviceId').value.trim()
  };
  const result = await api('/api/operator/cloud-config', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  state.cloudConfig = result.operator || {};
  renderCloudConfig();
  const nextBaseUrl = String(state.cloudConfig?.appBaseUrl || payload.appBaseUrl || '').trim();
  const nextVersion = normalizedBranchValue(state.cloudConfig?.appVersion || appVersion);
  const branchChanged = previousBaseUrl !== nextBaseUrl || previousVersion !== nextVersion;
  if (!branchChanged) {
    setMessage($('#cloudConfigMessage'), 'Rama EOLO Cloud guardada.', false);
    showToast({ type: 'success', title: 'EOLO Cloud actualizado', message: state.cloudConfig.branchLabel || '' });
    return;
  }
  setMessage($('#cloudConfigMessage'), 'Cambio de rama guardado. Cerrando sesion para iniciar de nuevo.', false);
  const closingToast = showToast({
    type: 'loading',
    title: 'Cerrando sesión',
    message: 'Debes iniciar de nuevo por el cambio de rama.',
    persist: true
  });
  setLoading(true);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  setLoading(false);
  dismissToast(closingToast);
  await logout();
}

async function extractVisitorNameFromIdPhoto() {
  if (!state.idPhotoDataUrl) return;
  if (!state.visionConfig) await loadOperatorVisionConfig().catch(() => {});
  if (!state.visionConfig?.enabled) {
    setIdVisionState('');
    return;
  }
  const form = $('#movementForm');
  const timeout = timeoutSignal(18000);
  setIdVisionState('Leyendo identificacion...', 'loading');
  try {
    const result = await api('/api/operator/identification/extract-name', {
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: state.idPhotoDataUrl }),
      signal: timeout.signal,
      silent: true
    });
    if (!result.enabled) {
      setIdVisionState('');
      return;
    }
    if (result.fullName && Number(result.confidence || 0) >= 0.45) {
      form.elements.visitor_name.value = result.fullName;
      setIdVisionState(`Nombre detectado (${Math.round(Number(result.confidence || 0) * 100)}%).`, 'ok');
      showToast({ type: 'success', title: 'Nombre detectado', message: result.fullName });
      return;
    }
    setIdVisionState('No se pudo leer el nombre con suficiente claridad.', 'fail');
    showToast({
      type: 'info',
      title: 'Nombre no detectado',
      message: 'Captura manualmente el nombre del visitante.'
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'La lectura tardo demasiado. Puedes continuar o capturar el nombre manualmente.'
      : error.message;
    setIdVisionState(message, 'fail');
    showToast({ type: 'error', title: 'OpenAI Vision no disponible', message });
  } finally {
    timeout.clear();
  }
}

function setIdVisionState(message, status = '') {
  const node = $('#idVisionState');
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('ok', status === 'ok');
  node.classList.toggle('fail', status === 'fail');
  node.classList.toggle('loading', status === 'loading');
}

async function refreshCloudStatus() {
  const dot = $('#cloudStatusDot');
  const wrapper = $('#cloudSyncStatus');
  if (!dot || !wrapper || !state.token) return;
  dot.classList.remove('online', 'offline', 'unknown');
  dot.classList.add('unknown');
  try {
    const result = await api('/api/operator/cloud-status');
    dot.classList.remove('unknown', 'online', 'offline');
    dot.classList.add(result.online ? 'online' : 'offline');
    wrapper.title = result.online
      ? `EOLO Cloud activo${result.latencyMs ? ` · ${result.latencyMs} ms` : ''}`
      : `Sin comunicacion EOLO${result.error ? ` · ${result.error}` : ''}`;
  } catch (error) {
    dot.classList.remove('unknown', 'online');
    dot.classList.add('offline');
    wrapper.title = `Sin comunicacion EOLO · ${error.message}`;
  }
}

function startCloudStatusTimer() {
  stopCloudStatusTimer();
  refreshCloudStatus().catch(() => {});
  state.cloudStatusTimer = setInterval(() => {
    refreshCloudStatus().catch(() => {});
  }, state.cloudStatusIntervalMs);
}

function stopCloudStatusTimer() {
  if (state.cloudStatusTimer) clearInterval(state.cloudStatusTimer);
  state.cloudStatusTimer = null;
}

async function loadCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('Este navegador no permite consultar cámaras.');
  }
  $('#cameraState').textContent = 'Consultando';
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((device) => device.kind === 'videoinput' && device.label)) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stopStream(stream);
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  state.cameras = devices.filter((device) => device.kind === 'videoinput');
  renderCameraSelect();
  $('#cameraState').textContent = state.cameras.length ? `${state.cameras.length} cámaras` : 'Sin cámaras';
}

function renderCameraSelect() {
  const select = $('#cameraSelect');
  select.innerHTML = state.cameras.length
    ? state.cameras
        .map((camera, index) => `<option value="${escapeHtml(camera.deviceId)}">${escapeHtml(camera.label || `Cámara ${index + 1}`)}</option>`)
        .join('')
    : '<option value="">Sin cámaras disponibles</option>';
  if (state.selectedCameraId && state.cameras.some((camera) => camera.deviceId === state.selectedCameraId)) {
    select.value = state.selectedCameraId;
  } else {
    state.selectedCameraId = select.value || '';
    if (state.selectedCameraId) localStorage.setItem('eolo.operator.cameraId', state.selectedCameraId);
  }
  updateSelectedCameraLabel();
}

function updateSelectedCameraLabel() {
  const camera = state.cameras.find((item) => item.deviceId === state.selectedCameraId);
  $('#selectedCameraLabel').textContent = camera?.label || (state.selectedCameraId ? 'Cámara seleccionada' : 'Sin seleccionar');
}

async function startCamera(video, { preview = 'settings' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('La cámara no está disponible en este navegador.');
  const constraints = state.selectedCameraId
    ? { video: { deviceId: { exact: state.selectedCameraId } } }
    : { video: true };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  if (preview === 'settings') state.settingsCameraStream = stream;
  else state.idCameraStream = stream;
  return stream;
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function stopSettingsCamera() {
  stopStream(state.settingsCameraStream);
  state.settingsCameraStream = null;
  $('#settingsCameraPreview').srcObject = null;
  $('#settingsCameraEmpty').classList.remove('hidden');
}

function stopIdCamera() {
  stopStream(state.idCameraStream);
  state.idCameraStream = null;
  $('#idCameraVideo').srcObject = null;
}

function closeIdCameraDialog() {
  stopIdCamera();
  const dialog = $('#idCameraDialog');
  if (dialog?.open) dialog.close();
}

async function testSettingsCamera() {
  stopSettingsCamera();
  await loadCameras();
  if (!state.selectedCameraId && !state.cameras.length) throw new Error('No se encontraron cámaras.');
  $('#settingsCameraEmpty').classList.add('hidden');
  await startCamera($('#settingsCameraPreview'), { preview: 'settings' });
}

async function openIdCamera(target = { type: 'visitor', index: -1 }) {
  state.photoCaptureTarget = target || { type: 'visitor', index: -1 };
  await loadCameras();
  if (!state.selectedCameraId && !state.cameras.length) throw new Error('No se encontraron cámaras.');
  stopIdCamera();
  const dialog = $('#idCameraDialog');
  if (!dialog.open) dialog.showModal();
  await startCamera($('#idCameraVideo'), { preview: 'id' });
}

function captureIdPhoto() {
  const video = $('#idCameraVideo');
  const canvas = $('#idCameraCanvas');
  const frame = $('#idGuideFrame');
  const crop = videoCropFromGuide(video, frame);
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  canvas.getContext('2d').drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
  closeIdCameraDialog();
  const target = state.photoCaptureTarget || { type: 'visitor', index: -1 };
  if (target.type === 'companion' && state.companions[target.index]) {
    state.companions[target.index].photoDataUrl = dataUrl;
    state.companions[target.index].photoUrl = '';
    renderCompanions();
    return;
  }
  state.idPhotoDataUrl = dataUrl;
  state.idPhotoUrl = '';
  renderIdPhoto();
  extractVisitorNameFromIdPhoto().catch(() => {});
}

function videoCropFromGuide(video, frame) {
  const videoWidth = video.videoWidth || 1280;
  const videoHeight = video.videoHeight || 720;
  const videoRect = video.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const scale = Math.max(videoRect.width / videoWidth, videoRect.height / videoHeight);
  const visibleWidth = videoRect.width / scale;
  const visibleHeight = videoRect.height / scale;
  const visibleX = (videoWidth - visibleWidth) / 2;
  const visibleY = (videoHeight - visibleHeight) / 2;
  const sx = visibleX + (frameRect.left - videoRect.left) / scale;
  const sy = visibleY + (frameRect.top - videoRect.top) / scale;
  const sw = frameRect.width / scale;
  const sh = frameRect.height / scale;
  const cropX = Math.max(0, Math.round(sx));
  const cropY = Math.max(0, Math.round(sy));
  return {
    sx: cropX,
    sy: cropY,
    sw: Math.max(1, Math.min(videoWidth - cropX, Math.round(sw))),
    sh: Math.max(1, Math.min(videoHeight - cropY, Math.round(sh)))
  };
}

function removeIdPhoto() {
  state.idPhotoDataUrl = '';
  state.idPhotoUrl = '';
  $('#idPhotoDataUrl').value = '';
  $('#idPhotoUrl').value = '';
  renderIdPhoto('');
  setIdVisionState('');
}

function removeVehiclePhoto() {
  setVehiclePhoto('');
}

function changeVehiclePhotoFromCamera() {
  if ($('#movementDialog').open) closeMovementDialog();
  showToast({
    type: 'info',
    title: 'Selecciona una placa',
    message: 'Haz clic sobre la placa ANPR en el visualizador para reemplazar la fotografia.'
  });
}

function renderMovementDetails(movement) {
  const details = $('#movementDetailList');
  if (!details) return;
  const items = [
    ['Empresa', movement?.company_text],
    ['Residente', movement ? movementVisitTo(movement) : ''],
    ['Conductor', movement?.driver],
    ['Caja 1', movement?.box_1],
    ['Caja 2', movement?.box_2]
  ].filter(([, value]) => displayText(value));
  details.innerHTML = items.length
    ? items.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(displayText(value))}</dd>`).join('')
    : '<dd>Sin datos adicionales.</dd>';
}

function formPayload() {
  const form = $('#movementForm');
  const data = Object.fromEntries(new FormData(form).entries());
  data.placa = sanitizePlateValue(data.placa || data.placas || '');
  data.placas = data.placa;
  data.visitor_name = sanitizePersonNameValue(data.visitor_name || data.nombre_visitante || '');
  data.nombre_visitante = data.visitor_name;
  const actionMode = controlPointActionMode(state.activeControlPoint);
  return {
    ...data,
    kind: state.movementKind,
    movement_type: state.movementType,
    id_acceso: state.activeAccess?.id || '',
    access_id2: state.activeAccess?.id2 || state.activeAccess?.id2_text || state.activeAccess?.raw?.id2_text || '',
    id_punto_control: state.activeControlPoint?.id || '',
    punto_control_name: controlPointLabel(state.activeControlPoint || {}),
    control_point_action: state.activeControlPoint?.actionType || '',
    control_point_action_mode: actionMode,
    status: actionMode === 'authorize' ? 'Pendiente' : 'Ingresado',
    operator_name: state.operator?.name || 'Operador EOLO',
    vehicle_driver_ids: JSON.stringify((state.vehicleDrivers || []).map((driver) => driver.id).filter(Boolean)),
    companions: JSON.stringify(
      (state.companions || [])
        .map((companion) => ({
          name: sanitizePersonNameValue(companion.name || ''),
          photoDataUrl: companion.photoDataUrl || '',
          photoUrl: companion.photoUrl || ''
        }))
        .filter((companion) => companion.name || companion.photoDataUrl || companion.photoUrl)
    )
  };
}

function setMovementBusy(isBusy, title = 'Sincronizando con EOLO Cloud') {
  const overlay = $('#movementBusyOverlay');
  const form = $('#movementForm');
  if (!overlay || !form) return;
  $('#movementBusyTitle').textContent = title;
  overlay.classList.toggle('hidden', !isBusy);
  form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  $$('button', form).forEach((button) => {
    button.disabled = isBusy;
  });
  if (!isBusy) {
    updateMovementActions(state.selectedMovement);
    const canChangeIdentification = !state.selectedMovement;
    $$('#idCaptureActions button').forEach((button) => {
      button.disabled = !canChangeIdentification;
    });
    const hasPhoto = Boolean(state.idPhotoDataUrl || state.idPhotoUrl || state.selectedMovement?.id_image);
    $('#openIdCameraBtn').classList.toggle('hidden', !canChangeIdentification || hasPhoto);
    $('#retakeIdPhotoBtn').classList.toggle('hidden', !canChangeIdentification || !hasPhoto);
    $('#removeIdPhotoBtn').classList.toggle('hidden', !canChangeIdentification || !hasPhoto);
    $$('#vehiclePhotoActions button').forEach((button) => {
      button.disabled = !canChangeIdentification;
    });
    $('#changeVehiclePhotoFromCameraBtn').classList.toggle('hidden', !canChangeIdentification);
    $('#removeVehiclePhotoBtn').classList.toggle('hidden', !canChangeIdentification || !state.vehiclePhotoDataUrl);
    $('#visitorIdCameraBtn').disabled = !canChangeIdentification;
    updateKindFields();
    setMovementFieldsReadOnly(Boolean(state.selectedMovement));
  }
}

async function saveMovement(event) {
  event.preventDefault();
  setMessage($('#movementMessage'), '');
  if (!state.activeControlPoint?.id) {
    const message = 'Selecciona un punto de control antes de registrar movimientos.';
    setMessage($('#movementMessage'), message);
    showToast({ type: 'info', title: 'Falta punto de control', message });
    return;
  }
  const payload = formPayload();
  const incompleteCompanion = (state.companions || []).find((companion) => !String(companion.name || '').trim());
  if (incompleteCompanion) {
    const message = 'Captura el nombre de cada acompañante o elimina el renglón vacío.';
    setMessage($('#movementMessage'), message);
    showToast({ type: 'info', title: 'Acompañante incompleto', message });
    return;
  }
  if (!state.selectedMovement && !payload.resident_id) {
    const message = 'Selecciona un residente valido de la lista.';
    setMessage($('#movementMessage'), message);
    showToast({ type: 'info', title: 'Residente requerido', message });
    $('#residentSearch').focus();
    return;
  }
  const actionLabel = state.selectedMovement ? 'Actualizando movimiento' : 'Creando movimiento';
  const loadingToast = showToast({
    type: 'loading',
    title: actionLabel,
    message: 'Sincronizando con EOLO Cloud.',
    persist: true
  });
  setMovementBusy(true, actionLabel);
  try {
    if (state.selectedMovement) {
      await api(`/api/operator/movements/${state.selectedMovement.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...payload, action: 'update' })
      });
    } else {
      const result = await api('/api/operator/movements', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (result.pending) {
        dismissToast(loadingToast);
        setMessage($('#movementMessage'), 'Movimiento guardado localmente. Se sincronizara cuando EOLO Cloud responda.', false);
        showToast({
          type: 'info',
          title: 'Guardado local',
          message: 'EOLO Cloud no respondio; el registro quedo en Movimientos por sincronizar.'
        });
        await loadPendingMovements();
        setMovementBusy(false);
        setTimeout(closeMovementDialog, 250);
        return;
      }
    }
    dismissToast(loadingToast);
    setMessage($('#movementMessage'), 'Movimiento guardado.', false);
    showToast({
      type: 'success',
      title: state.selectedMovement ? 'Movimiento actualizado' : 'Ingreso registrado',
      message: 'La informacion quedo sincronizada.'
    });
    await loadMovements();
    setMovementBusy(false);
    setTimeout(closeMovementDialog, 250);
  } catch (error) {
    dismissToast(loadingToast);
    setMovementBusy(false);
    setMessage($('#movementMessage'), error.message);
    showToast({ type: 'error', title: 'No se pudo guardar', message: error.message });
  }
}

async function egressMovement() {
  if (!state.selectedMovement) return;
  setMessage($('#movementMessage'), '');
  const loadingToast = showToast({
    type: 'loading',
    title: 'Registrando egreso',
    message: 'Sincronizando con EOLO Cloud.',
    persist: true
  });
  setMovementBusy(true, 'Registrando egreso');
  try {
    await api(`/api/operator/movements/${state.selectedMovement.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'egress',
        access_id: state.activeAccess?.id || state.selectedMovement?.accessId || '',
        operator_name: state.operator?.name || 'Operador EOLO',
        id_punto_control: state.activeControlPoint?.id || '',
        vehicle_exit_photo_data_url: state.vehicleExitPhotoDataUrl || '',
        exit_photo_data_url: state.vehicleExitPhotoDataUrl || '',
        camera:
          state.activeControlPoint?.exitCamera ||
          state.activeControlPoint?.cameras?.find((camera) => camera.type === 'Salida')?.name ||
          state.activeAccess?.cameras?.find((camera) => camera.type === 'Salida')?.name ||
          ''
        })
    });
    dismissToast(loadingToast);
    setMessage($('#movementMessage'), 'Salida registrada.', false);
    showToast({ type: 'success', title: 'Egreso registrado', message: 'La salida quedo sincronizada.' });
    await loadMovements();
    setMovementBusy(false);
    setTimeout(closeMovementDialog, 250);
  } catch (error) {
    dismissToast(loadingToast);
    setMovementBusy(false);
    setMessage($('#movementMessage'), error.message);
    showToast({ type: 'error', title: 'No se pudo egresar', message: error.message });
  }
}

async function syncNow() {
  $('#syncState').textContent = 'Sincronizando...';
  try {
    await syncPendingMovements({ force: true, silent: true }).catch(() => {});
    const syncResult = await api('/api/operator/sync', {
      method: 'POST',
      body: JSON.stringify({ access_id: state.activeAccess?.id || '' })
    });
    if (syncResult.deviceHeartbeat && syncResult.deviceHeartbeat.ok === false) {
      showToast({
        type: 'error',
        title: 'Dispositivo no monitoreado',
        message: syncResult.deviceHeartbeat.error || 'EOLO Cloud no actualizo Ultima Comunicacion.'
      });
    }
    await loadMovements();
    await loadPendingMovements().catch(() => {});
    refreshCloudStatus().catch(() => {});
  } catch (error) {
    $('#syncState').textContent = error.message;
  }
}

function startAutoSync() {
  stopAutoSync();
  state.syncTimer = setInterval(syncNow, state.syncIntervalMs);
}

function stopAutoSync() {
  if (state.syncTimer) clearInterval(state.syncTimer);
  state.syncTimer = null;
}

function startPendingSyncTimer() {
  stopPendingSyncTimer();
  state.pendingSyncTimer = setInterval(() => {
    if (!state.pendingMovements.length) return;
    syncPendingMovements({ silent: true }).catch(() => {});
  }, 60 * 1000);
}

function stopPendingSyncTimer() {
  if (state.pendingSyncTimer) clearInterval(state.pendingSyncTimer);
  state.pendingSyncTimer = null;
}

function bindEvents() {
  initPinSegments();
  $('#loginForm').addEventListener('submit', login);
  $('#sidebarToggle').addEventListener('click', () => {
    $('#operatorShell').classList.toggle('sidebar-collapsed');
  });
  $$('[data-profile-trigger]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = button.closest('[data-profile-menu]');
      $$('[data-profile-menu]').forEach((item) => {
        if (item !== menu) item.classList.remove('open');
      });
      menu?.classList.toggle('open');
    });
  });
  $$('[data-logout]').forEach((button) => button.addEventListener('click', logout));
  $$('[data-menu-settings]').forEach((button) => {
    button.addEventListener('click', () => {
      $$('[data-profile-menu]').forEach((menu) => menu.classList.remove('open'));
      showSettings();
    });
  });
  $$('[data-open-technical-settings]').forEach((button) => {
    button.addEventListener('click', () => {
      $$('[data-profile-menu]').forEach((menu) => menu.classList.remove('open'));
      window.location.assign('/settings');
    });
  });
  $('#syncState').addEventListener('click', syncNow);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-profile-menu]')) return;
    $$('[data-profile-menu]').forEach((menu) => menu.classList.remove('open'));
    if (!event.target.closest('#driverOverlay') && !event.target.closest('#driverOverlayBtn')) {
      closeDriverOverlay();
    }
  });
  $('#refreshAccessesBtn').addEventListener('click', () => loadAccesses().catch((error) => {
    $('#accessSourceState').textContent = error.message;
  }));
  $('#activeAccessBtn').addEventListener('click', () => showAccessPicker({ clearControlPoint: true }));
  $('#activeControlPointBtn').addEventListener('click', openControlPointDialog);
  $$('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.activeControlPoint) return;
      if (button.dataset.view === 'settings') showSettings();
      if (button.dataset.view === 'movements') showMovements();
    });
  });
  $('#backToAccessesBtn').addEventListener('click', () => showAccessPicker({ clearControlPoint: true }));
  $('#refreshControlPointsBtn').addEventListener('click', () => loadControlPoints().catch((error) => {
    $('#controlPointSourceState').textContent = error.message;
  }));
  $('#accessPickerGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-access-index]');
    if (!card) return;
    selectAccess(Number(card.dataset.accessIndex)).catch((error) => {
      $('#accessSourceState').textContent = error.message;
    });
  });
  $('#controlPointPickerGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-control-point-index]');
    if (!card) return;
    selectControlPoint(Number(card.dataset.controlPointIndex)).catch((error) => {
      $('#controlPointSourceState').textContent = error.message;
    });
  });
  $('#controlPointDialogGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-control-point-index]');
    if (!card) return;
    selectControlPoint(Number(card.dataset.controlPointIndex)).catch((error) => {
      $('#controlPointDialogMeta').textContent = error.message;
    });
  });
  $('#controlPointDialog').addEventListener('cancel', (event) => {
    if (!state.controlPointSelectionRequired) return;
    event.preventDefault();
  });
  $('#closeControlPointDialogBtn').addEventListener('click', () => {
    state.controlPointSelectionRequired = false;
    $('#controlPointDialog').close();
  });
  $('#refreshCamerasBtn').addEventListener('click', () => {
    loadCameras()
      .then(() => showToast({ type: 'success', title: 'Cámaras actualizadas' }))
      .catch((error) => showToast({ type: 'error', title: 'No se pudieron consultar cámaras', message: error.message }));
  });
  $('#cameraSelect').addEventListener('change', (event) => {
    state.selectedCameraId = event.target.value;
    if (state.selectedCameraId) localStorage.setItem('eolo.operator.cameraId', state.selectedCameraId);
    else localStorage.removeItem('eolo.operator.cameraId');
    updateSelectedCameraLabel();
    stopSettingsCamera();
  });
  $('#testCameraBtn').addEventListener('click', () => {
    testSettingsCamera().catch((error) => showToast({ type: 'error', title: 'No se pudo abrir la cámara', message: error.message }));
  });
  $('#stopSettingsCameraBtn').addEventListener('click', stopSettingsCamera);
  $$('[data-operator-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => setOperatorSettingsTab(button.dataset.operatorSettingsTab));
  });
  $('#visionEnabled').addEventListener('change', syncVisionControls);
  $('#changeVisionKey').addEventListener('change', syncVisionControls);
  $('#saveVisionConfigBtn').addEventListener('click', () => {
    saveVisionConfig().catch((error) => setMessage($('#visionConfigMessage'), error.message));
  });
  $('#cloudBranchPreset').addEventListener('change', syncCloudControls);
  $('#saveCloudConfigBtn').addEventListener('click', () => {
    saveCloudConfig().catch((error) => setMessage($('#cloudConfigMessage'), error.message));
  });
  $('#syncPendingNowBtn').addEventListener('click', () => {
    syncPendingMovements({ force: true }).catch((error) => {
      showToast({ type: 'error', title: 'No se pudo sincronizar', message: error.message });
    });
  });
  $('#streamCameraPanel').addEventListener('change', (event) => {
    if (event.target.matches('.stream-preview-toggle')) {
      toggleStreamPreview(event.target.checked);
    }
    if (event.target.matches('.anpr-log-toggle')) {
      updateAnprLogVisibility(event.target.checked);
    }
  });
  $('#streamCameraPanel').addEventListener('input', (event) => {
    if (event.target.matches('.stream-frame-height-range')) {
      updateStreamFrameHeight(event.target.value);
    }
  });
  $('#streamCameraPanel').addEventListener('click', (event) => {
    const toolsButton = event.target.closest('.stream-tools-toggle');
    if (toolsButton) {
      toggleStreamTools();
      return;
    }
    const layoutButton = event.target.closest('.stream-layout-toggle');
    if (layoutButton) {
      toggleStreamInventoryLayout();
      return;
    }
    const plateButton = event.target.closest('[data-anpr-plate]');
    if (!plateButton) return;
    useAnprPlateForMovement(plateButton.dataset.anprPlate || '').catch((error) => {
      showToast({ type: 'error', title: 'No se pudo capturar la placa', message: error.message });
    });
  });
  $('#streamCameraCollapseBtn').addEventListener('click', toggleStreamCameraPanel);
  $('#newMovementBtn').addEventListener('click', () => openMovementDialog(null, { focusPlate: true }));
  $('#movementSearch').addEventListener('input', () => {
    resetMovementPage();
    renderMovementFilterState();
    loadMovements().catch(() => {});
  });
  $('#statusFilter').addEventListener('change', () => {
    resetMovementPage();
    renderMovementFilterState();
    loadMovements().catch(() => {});
  });
  $('#clearMovementSearchBtn').addEventListener('click', () => {
    $('#movementSearch').value = '';
    resetMovementPage();
    renderMovementFilterState();
    loadMovements().catch(() => {});
    $('#movementSearch').focus();
  });
  $('#clearStatusFilterBtn').addEventListener('click', () => {
    $('#statusFilter').value = '';
    resetMovementPage();
    renderMovementFilterState();
    loadMovements().catch(() => {});
  });
  $('#prevMovementsPageBtn').addEventListener('click', () => {
    if (state.movementPage <= 1) return;
    state.movementPage -= 1;
    loadMovements().catch(() => {});
  });
  $('#nextMovementsPageBtn').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.movementTotal / state.movementPageSize));
    if (state.movementPage >= totalPages) return;
    state.movementPage += 1;
    loadMovements().catch(() => {});
  });
  $('#movementRows').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-movement-id]');
    if (!row) return;
    const movement = state.movements.find((item) => String(item.id) === row.dataset.movementId);
    if (movement) openMovementDialog(movement);
  });
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', closeMovementDialog));
  $$('[data-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      state.movementKind = button.dataset.kind;
      setKindButtons();
      if (state.movementKind === 'Vehiculo') schedulePlateHistoryLookup();
    });
  });
  $$('[data-movement-type]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.residentVehicleProfile && button.dataset.movementType !== 'Residente') {
        clearResidentVehicleProfile();
      }
      state.movementType = button.dataset.movementType;
      setMovementTypeButtons();
    });
  });
  $('#vehicleDetailsToggle')?.addEventListener('click', () => {
    const details = $('#vehicleDetails');
    if (!details || details.hidden || state.movementKind !== 'Vehiculo') return;
    setVehicleDetailsCollapsed(!details.classList.contains('collapsed'));
  });
  $('#driverOverlayBtn')?.addEventListener('click', () => {
    if (state.driverOverlayOpen) closeDriverOverlay();
    else openDriverOverlay();
  });
  $('#driverOverlay')?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  $('#driverOverlay')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-driver-id]');
    if (!option) return;
    selectDriver(option.dataset.driverId || '');
  });
  $('#addCompanionBtn')?.addEventListener('click', addCompanion);
  $('#companionsList')?.addEventListener('input', (event) => {
    const input = event.target.closest('[data-companion-name]');
    if (!input) return;
    updateCompanionName(Number(input.dataset.companionName), input.value);
  });
  $('#companionsList')?.addEventListener('click', (event) => {
    const photoButton = event.target.closest('[data-companion-photo]');
    if (photoButton) {
      openIdCamera({ type: 'companion', index: Number(photoButton.dataset.companionPhoto) })
        .catch((error) => showToast({ type: 'error', title: 'No se pudo abrir la cámara', message: error.message }));
      return;
    }
    const removeButton = event.target.closest('[data-companion-remove]');
    if (removeButton) removeCompanion(Number(removeButton.dataset.companionRemove));
  });
  $('#changeResidentBtn').addEventListener('click', () => clearResidentSelection({ focus: true, loadAll: true }));
  $('#clearAutoResidentBtn')?.addEventListener('click', () => clearResidentVehicleProfile({ focus: true }));
  $('#residentSearch').addEventListener('input', (event) => {
    state.selectedResident = null;
    $('#residentId').value = '';
    $('#movementForm').elements.visit_to.value = '';
    $('#changeResidentBtn').classList.add('hidden');
    const search = event.target.value.trim();
    openResidentOverlay();
    clearTimeout(state.residentSearchTimer);
    state.residentSearchTimer = setTimeout(() => {
      loadResidents(search).catch((error) => setMessage($('#movementMessage'), error.message));
    }, 220);
  });
  $('#residentSearch').addEventListener('focus', openResidentOverlay);
  $('#residentSearch').addEventListener('blur', () => {
    setTimeout(closeResidentOverlay, 120);
  });
  $('#residentList').addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  $('#residentList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-resident-id]');
    if (!button) return;
    const resident = state.residents.find((item) => String(item.id) === button.dataset.residentId);
    if (resident) selectResident(resident);
  });
  window.addEventListener('resize', () => {
    if (state.residentInputFocused) positionResidentOverlay();
    if (state.driverOverlayOpen) positionDriverOverlay();
  });
  $('#movementDialog').addEventListener('scroll', () => {
    if (state.residentInputFocused) positionResidentOverlay();
    if (state.driverOverlayOpen) positionDriverOverlay();
  }, true);
  $('#movementForm').addEventListener('submit', saveMovement);
  $('#movementForm').elements.placa?.addEventListener('input', () => {
    sanitizePlateInput();
    if (state.driverOverlayOpen) renderDriverOverlay();
    schedulePlateHistoryLookup();
  });
  $('#movementForm').elements.visitor_name?.addEventListener('blur', sanitizeVisitorNameInput);
  $('#vehiclePhotoTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-vehicle-photo-view]');
    if (!button) return;
    state.vehiclePhotoView = button.dataset.vehiclePhotoView === 'exit' ? 'exit' : 'entry';
    renderVehiclePhoto();
  });
  $('#egressBtn').addEventListener('click', egressMovement);
  $('#visitorIdCameraBtn').addEventListener('click', () => {
    openIdCamera({ type: 'visitor', index: -1 }).catch((error) => showToast({ type: 'error', title: 'No se pudo abrir la cámara', message: error.message }));
  });
  $('#openIdCameraBtn').addEventListener('click', () => {
    openIdCamera({ type: 'visitor', index: -1 }).catch((error) => showToast({ type: 'error', title: 'No se pudo abrir la cámara', message: error.message }));
  });
  $('#captureIdPhotoBtn').addEventListener('click', captureIdPhoto);
  $('#cancelIdCameraBtn').addEventListener('click', closeIdCameraDialog);
  $('#idCameraDialog').addEventListener('close', stopIdCamera);
  $('#retakeIdPhotoBtn').addEventListener('click', () => {
    openIdCamera({ type: 'visitor', index: -1 }).catch((error) => showToast({ type: 'error', title: 'No se pudo abrir la cámara', message: error.message }));
  });
  $('#removeIdPhotoBtn').addEventListener('click', removeIdPhoto);
  $('#removeVehiclePhotoBtn').addEventListener('click', removeVehiclePhoto);
  $('#changeVehiclePhotoFromCameraBtn').addEventListener('click', changeVehiclePhotoFromCamera);
  bindKeyboardShortcuts();
}

bindEvents();
restoreSession();
