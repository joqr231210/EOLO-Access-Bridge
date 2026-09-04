import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { DEFAULT_USER_SYNC_WORKFLOW, normalizeWorkflowEndpoint } from './eoloWorkflow.js';

const runtimeConfigPath = () => path.join(config.dataDir, 'device-config.json');

export async function loadRuntimeConfig() {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await fs.promises.readFile(runtimeConfigPath(), 'utf8'));
    applyRuntimeConfig(saved, { preservePassword: false });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    applyRuntimeConfig({}, { preservePassword: false });
  }
}

export async function saveRuntimeConfig(input) {
  const next = applyRuntimeConfig(input, { preservePassword: true });
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  await fs.promises.writeFile(runtimeConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return publicRuntimeConfig();
}

export function publicRuntimeConfig() {
  return {
    mockDevice: config.mockDevice,
    faceDevice: config.faceDevice,
    faceDevices: publicFaceDevices(),
    hikvision: {
      bridgeIdentifier: config.hikvision.bridgeIdentifier,
      localDeviceId: config.hikvision.localDeviceId,
      protocol: config.hikvision.protocol,
      host: config.hikvision.host,
      port: config.hikvision.port,
      username: config.hikvision.username,
      passwordSet: Boolean(config.hikvision.password),
      doorNo: config.hikvision.doorNo,
      planTemplateNo: config.hikvision.planTemplateNo,
      fdid: config.hikvision.fdid,
      faceLibType: config.hikvision.faceLibType,
      dedupWindowSeconds: Math.round(config.hikvision.dedupWindowMs / 1000)
    },
    dahua: {
      bridgeIdentifier: config.dahua.bridgeIdentifier,
      localDeviceId: config.dahua.localDeviceId,
      protocol: config.dahua.protocol,
      host: config.dahua.host,
      port: config.dahua.port,
      username: config.dahua.username,
      passwordSet: Boolean(config.dahua.password),
      doorNo: config.dahua.doorNo,
      cardType: config.dahua.cardType,
      validYears: config.dahua.validYears,
      dedupWindowSeconds: Math.round(config.dahua.dedupWindowMs / 1000),
      eventCodes: config.dahua.eventCodes,
      heartbeatSeconds: config.dahua.heartbeatSeconds
    },
    eolo: {
      tokenSet: Boolean(config.eolo.token),
      userSyncEnabled: config.eolo.userSyncEnabled,
      userSyncEndpoint: config.eolo.userSyncEndpoint,
      access: config.eolo.access,
      userSyncIntervalMinutes: Math.round(config.eolo.userSyncIntervalMs / 60000)
    },
    openaiVision: {
      enabled: config.openaiVision.enabled,
      apiKeySet: Boolean(config.openaiVision.apiKey),
      model: config.openaiVision.model,
      timeoutSeconds: Math.round(config.openaiVision.timeoutMs / 1000)
    },
    operator: {
      appBaseUrl: config.operator.appBaseUrl,
      appVersion: config.operator.appVersion,
      authMode: config.operator.authMode,
      deviceHeartbeatEnabled: config.operator.deviceHeartbeatEnabled,
      deviceHeartbeatEndpoint: config.operator.deviceHeartbeatEndpoint,
      deviceDataType: config.operator.deviceDataType,
      deviceId: config.operator.deviceId,
      serialNumber: config.operator.serialNumber,
      syncIntervalMinutes: Math.round(config.operator.syncIntervalMs / 60000)
    }
  };
}

export function applyRuntimeConfig(input, { preservePassword }) {
  const current = config.hikvision;
  const currentDahua = config.dahua;
  const currentEolo = config.eolo;
  const currentVision = config.openaiVision;
  const currentOperator = config.operator;
  const hikvision = input.hikvision || input;
  const dahua = input.dahua || {};
  const eolo = input.eolo || {};
  const openaiVision = input.openaiVision || {};
  const operator = input.operator || {};
  const protocol = String(hikvision.protocol || current.protocol || 'http').toLowerCase();
  const host = String(hikvision.host || current.host || '').trim();
  const username = String(hikvision.username || current.username || '').trim();
  const port = intInRange(hikvision.port, current.port || 80, 1, 65535);
  const bridgeIdentifier = String(
    hikvision.bridgeIdentifier ?? current.bridgeIdentifier ?? 'Nuevo Dispositivo Bridge'
  ).trim();
  const localDeviceId = String(hikvision.localDeviceId ?? current.localDeviceId ?? '').trim();
  const faceDevice = ['hikvision', 'dahua'].includes(String(input.faceDevice || config.faceDevice))
    ? String(input.faceDevice || config.faceDevice)
    : 'hikvision';
  const dahuaProtocol = String(dahua.protocol || currentDahua.protocol || 'http').toLowerCase();
  const dahuaHost = String(dahua.host ?? currentDahua.host ?? '').trim();
  const dahuaUsername = String(dahua.username ?? currentDahua.username ?? '').trim();
  const dahuaBridgeIdentifier = String(
    dahua.bridgeIdentifier ?? currentDahua.bridgeIdentifier ?? 'Dahua ASI'
  ).trim();
  const dahuaLocalDeviceId = String(dahua.localDeviceId ?? currentDahua.localDeviceId ?? '').trim();
  let userSyncEndpoint = '';
  try {
    userSyncEndpoint = normalizeWorkflowEndpoint(
      eolo.userSyncEndpoint || currentEolo.userSyncEndpoint || DEFAULT_USER_SYNC_WORKFLOW
    );
  } catch (error) {
    throw validationError(error.message);
  }
  const userSyncIntervalMinutes =
    eolo.userSyncIntervalMinutes ??
    (eolo.userSyncIntervalMs ? Number(eolo.userSyncIntervalMs) / 60000 : undefined);

  if (!['http', 'https'].includes(protocol)) {
    throw validationError('protocol debe ser http o https');
  }
  if (!['http', 'https'].includes(dahuaProtocol)) {
    throw validationError('El protocolo Dahua debe ser http o https');
  }
  if (!host) throw validationError('La IP o host del dispositivo es obligatorio');
  if (!username) throw validationError('El usuario de autenticacion es obligatorio');
  if (faceDevice === 'dahua' && !dahuaHost) {
    throw validationError('La IP o host del Dahua ASI es obligatorio');
  }
  if (faceDevice === 'dahua' && !dahuaUsername) {
    throw validationError('El usuario Dahua es obligatorio');
  }
  if (eolo.userSyncEnabled && !userSyncEndpoint) {
    throw validationError('El endpoint de sincronizacion EOLO es obligatorio');
  }
  if (openaiVision.enabled && !String(openaiVision.apiKey || currentVision.apiKey || '').trim()) {
    throw validationError('La API key de OpenAI es obligatoria para activar Vision.');
  }
  const operatorAppBaseUrl = String(operator.appBaseUrl ?? currentOperator.appBaseUrl ?? 'https://eolo.app')
    .trim()
    .replace(/\/+$/, '');
  const operatorAppVersion = normalizeOperatorVersion(
    operator.appVersion ?? currentOperator.appVersion ?? 'live'
  );
  const operatorDeviceId = normalizeOperatorDeviceId(
    operator.deviceId ?? currentOperator.deviceId ?? ''
  );
  const operatorSerialNumber = normalizeOperatorSerialNumber(
    operator.serialNumber ?? operator.sn ?? currentOperator.serialNumber ?? ''
  );
  const operatorDeviceDataType = String(currentOperator.deviceDataType ?? 'dispositivosacceso')
    .trim()
    .replace(/^custom\./, '');
  const operatorDeviceHeartbeatEndpoint = String(
    currentOperator.deviceHeartbeatEndpoint ?? 'bridge_operator_device_heartbeat'
  ).trim();
  if (!operatorAppBaseUrl) throw validationError('La URL base de EOLO Cloud es obligatoria');
  try {
    new URL(operatorAppBaseUrl);
  } catch {
    throw validationError('La URL base de EOLO Cloud no es valida');
  }
  if (operatorDeviceDataType && !/^[A-Za-z0-9_-]{1,80}$/.test(operatorDeviceDataType)) {
    throw validationError('El tipo de dato del dispositivo EOLO Cloud no es valido');
  }
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(operatorDeviceHeartbeatEndpoint)) {
    throw validationError('El workflow de heartbeat EOLO Cloud no es valido');
  }

  config.mockDevice =
    typeof input.mockDevice === 'boolean' ? input.mockDevice : Boolean(config.mockDevice);
  config.faceDevice = faceDevice;
  config.hikvision = {
    ...current,
    bridgeIdentifier: bridgeIdentifier || 'Nuevo Dispositivo Bridge',
    localDeviceId,
    protocol,
    host,
    port,
    username,
    password:
      preservePassword && hikvision.password === ''
        ? current.password
        : String(hikvision.password ?? current.password ?? ''),
    doorNo: intInRange(hikvision.doorNo, current.doorNo || 1, 1, 128),
    planTemplateNo: String(hikvision.planTemplateNo || current.planTemplateNo || '1'),
    fdid: String(hikvision.fdid || current.fdid || '1'),
    faceLibType: String(hikvision.faceLibType || current.faceLibType || 'blackFD'),
    dedupWindowMs:
      intInRange(hikvision.dedupWindowSeconds, Math.round(current.dedupWindowMs / 1000) || 8, 1, 120) *
      1000
  };
  config.dahua = {
    ...currentDahua,
    bridgeIdentifier: dahuaBridgeIdentifier || 'Dahua ASI',
    localDeviceId: dahuaLocalDeviceId,
    protocol: dahuaProtocol,
    host: dahuaHost,
    port: intInRange(dahua.port, currentDahua.port || 80, 1, 65535),
    username: dahuaUsername,
    password:
      preservePassword && dahua.password === ''
        ? currentDahua.password
        : String(dahua.password ?? currentDahua.password ?? ''),
    doorNo: intInRange(dahua.doorNo, currentDahua.doorNo ?? 0, 0, 128),
    cardType: intInRange(dahua.cardType, currentDahua.cardType ?? 0, 0, 255),
    validYears: intInRange(dahua.validYears, currentDahua.validYears || 10, 1, 50),
    dedupWindowMs:
      intInRange(
        dahua.dedupWindowSeconds,
        Math.round(currentDahua.dedupWindowMs / 1000) || 8,
        1,
        120
      ) * 1000,
    eventCodes: String(dahua.eventCodes ?? currentDahua.eventCodes ?? 'All').trim() || 'All',
    heartbeatSeconds: intInRange(dahua.heartbeatSeconds, currentDahua.heartbeatSeconds || 5, 1, 60)
  };
  config.eolo = {
    ...currentEolo,
    token:
      preservePassword && eolo.token === ''
        ? currentEolo.token
        : String(eolo.token ?? currentEolo.token ?? ''),
    userSyncEnabled:
      typeof eolo.userSyncEnabled === 'boolean'
        ? eolo.userSyncEnabled
        : Boolean(currentEolo.userSyncEnabled),
    userSyncEndpoint,
    access: String(eolo.access ?? currentEolo.access ?? '').trim(),
    userSyncIntervalMs:
      intInRange(
        userSyncIntervalMinutes,
        Math.round(currentEolo.userSyncIntervalMs / 60000) || 30,
        1,
        1440
      ) *
      60 *
      1000
  };
  config.openaiVision = {
    ...currentVision,
    enabled:
      typeof openaiVision.enabled === 'boolean'
        ? openaiVision.enabled
        : Boolean(currentVision.enabled),
    apiKey:
      preservePassword && openaiVision.apiKey === ''
        ? currentVision.apiKey
        : String(openaiVision.apiKey ?? currentVision.apiKey ?? ''),
    model: String(openaiVision.model || currentVision.model || 'gpt-4o-mini').trim(),
    timeoutMs:
      intInRange(
        openaiVision.timeoutSeconds ??
          (openaiVision.timeoutMs ? Number(openaiVision.timeoutMs) / 1000 : undefined),
        Math.round(currentVision.timeoutMs / 1000) || 18,
        5,
        60
      ) * 1000
  };
  config.operator = {
    ...currentOperator,
    appBaseUrl: operatorAppBaseUrl,
    appVersion: operatorAppVersion,
    deviceHeartbeatEnabled:
      typeof operator.deviceHeartbeatEnabled === 'boolean'
        ? operator.deviceHeartbeatEnabled
        : Boolean(currentOperator.deviceHeartbeatEnabled),
    deviceHeartbeatEndpoint: operatorDeviceHeartbeatEndpoint,
    deviceDataType: operatorDeviceDataType || 'dispositivosacceso',
    deviceId: operatorDeviceId,
    serialNumber: operatorSerialNumber,
    syncIntervalMs:
      intInRange(
        operator.syncIntervalMinutes ??
          (operator.syncIntervalMs ? Number(operator.syncIntervalMs) / 60000 : undefined),
        Math.round(currentOperator.syncIntervalMs / 60000) || 5,
        1,
        1440
      ) *
      60 *
      1000
  };
  config.faceDevices = normalizeFaceDevices(input.faceDevices, {
    preservePassword,
    currentDevices: config.faceDevices,
    fallbackDevices: buildDefaultFaceDevices()
  });

  return {
    mockDevice: config.mockDevice,
    faceDevice: config.faceDevice,
    faceDevices: config.faceDevices,
    hikvision: config.hikvision,
    dahua: config.dahua,
    eolo: config.eolo,
    openaiVision: config.openaiVision,
    operator: config.operator
  };
}

function publicFaceDevices() {
  return normalizeFaceDevices(config.faceDevices, {
    preservePassword: true,
    currentDevices: config.faceDevices,
    fallbackDevices: buildDefaultFaceDevices()
  }).map((device) => {
    const { password, ...safeDevice } = device;
    return {
      ...safeDevice,
      passwordSet: Boolean(password)
    };
  });
}

function buildDefaultFaceDevices() {
  return [
    faceDeviceFromLegacy('hikvision', config.hikvision, config.faceDevice === 'hikvision'),
    faceDeviceFromLegacy('dahua', config.dahua, config.faceDevice === 'dahua')
  ];
}

function faceDeviceFromLegacy(type, settings = {}, enabled) {
  return {
    id: type,
    type,
    name:
      settings.bridgeIdentifier ||
      (type === 'dahua' ? 'Dahua ASI' : 'Hikvision Mini Moe'),
    enabled: Boolean(enabled),
    bridgeIdentifier:
      settings.bridgeIdentifier ||
      (type === 'dahua' ? 'Dahua ASI' : 'Nuevo Dispositivo Bridge'),
    localDeviceId: settings.localDeviceId || '',
    controlPointId: settings.controlPointId || '',
    controlPointName: settings.controlPointName || '',
    protocol: settings.protocol || 'http',
    host: settings.host || '',
    port: settings.port || 80,
    username: settings.username || '',
    password: settings.password || '',
    doorNo: settings.doorNo ?? (type === 'dahua' ? 0 : 1),
    planTemplateNo: settings.planTemplateNo || '1',
    fdid: settings.fdid || '1',
    faceLibType: settings.faceLibType || 'blackFD',
    cardType: settings.cardType ?? 0,
    validYears: settings.validYears || 10,
    dedupWindowSeconds: Math.round((settings.dedupWindowMs || 8000) / 1000),
    eventCodes: settings.eventCodes || 'All',
    heartbeatSeconds: settings.heartbeatSeconds || 5,
    streamDesired: Boolean(settings.streamDesired),
    lastTestOk: Boolean(settings.lastTestOk),
    lastTestAt: settings.lastTestAt || '',
    lastTestMessage: settings.lastTestMessage || '',
    lastTestStatus: settings.lastTestStatus || '',
    lastTestTarget: settings.lastTestTarget || ''
  };
}

function normalizeFaceDevices(inputDevices, { preservePassword, currentDevices = [], fallbackDevices = [] }) {
  const source = Array.isArray(inputDevices)
    ? inputDevices
    : currentDevices.length
      ? currentDevices
      : fallbackDevices;
  const currentById = new Map((currentDevices || []).map((device) => [device.id, device]));
  const normalized = [];
  for (const raw of source) {
    const type = normalizeFaceDeviceType(raw?.type);
    if (!type) continue;
    const id = normalizeFaceDeviceId(raw?.id || `${type}-${normalized.length + 1}`);
    if (!id || normalized.some((device) => device.id === id)) continue;
    const current = currentById.get(id) || {};
    const device = normalizeFaceDevice(raw, {
      type,
      id,
      current,
      preservePassword
    });
    normalized.push(device);
  }
  return normalized.length ? normalized : fallbackDevices.map((device) => ({ ...device }));
}

function normalizeFaceDevice(raw = {}, { type, id, current = {}, preservePassword }) {
  const protocol = String(raw.protocol || current.protocol || 'http').toLowerCase();
  if (!['http', 'https'].includes(protocol)) {
    throw validationError('El protocolo del dispositivo facial debe ser http o https');
  }
  const host = String(raw.host ?? current.host ?? '').trim();
  const username = String(raw.username ?? current.username ?? '').trim();
  if (!host) throw validationError('La IP o host del dispositivo facial es obligatorio');
  if (!username) throw validationError('El usuario del dispositivo facial es obligatorio');
  const fallbackName = type === 'dahua' ? 'Dahua ASI' : 'Hikvision Mini Moe';
  return {
    id,
    type,
    enabled: raw.enabled === undefined ? Boolean(current.enabled) : Boolean(raw.enabled),
    name: String(raw.name || current.name || raw.bridgeIdentifier || fallbackName).trim() || fallbackName,
    bridgeIdentifier:
      String(raw.bridgeIdentifier || current.bridgeIdentifier || raw.name || fallbackName).trim() ||
      fallbackName,
    localDeviceId: String(raw.localDeviceId ?? current.localDeviceId ?? '').trim(),
    controlPointId: String(raw.controlPointId ?? raw.control_point_id ?? current.controlPointId ?? '').trim(),
    controlPointName: String(raw.controlPointName ?? raw.control_point_name ?? current.controlPointName ?? '').trim(),
    protocol,
    host,
    port: intInRange(raw.port, current.port || 80, 1, 65535),
    username,
    password:
      preservePassword && raw.password === ''
        ? current.password || ''
        : String(raw.password ?? current.password ?? ''),
    doorNo: intInRange(raw.doorNo, current.doorNo ?? (type === 'dahua' ? 0 : 1), type === 'dahua' ? 0 : 1, 128),
    planTemplateNo: String(raw.planTemplateNo || current.planTemplateNo || '1'),
    fdid: String(raw.fdid || current.fdid || '1'),
    faceLibType: String(raw.faceLibType || current.faceLibType || 'blackFD'),
    cardType: intInRange(raw.cardType, current.cardType ?? 0, 0, 255),
    validYears: intInRange(raw.validYears, current.validYears || 10, 1, 50),
    dedupWindowSeconds: intInRange(raw.dedupWindowSeconds, current.dedupWindowSeconds || 8, 1, 120),
    eventCodes: String(raw.eventCodes ?? current.eventCodes ?? 'All').trim() || 'All',
    heartbeatSeconds: intInRange(raw.heartbeatSeconds, current.heartbeatSeconds || 5, 1, 60),
    streamDesired: Boolean(raw.streamDesired ?? current.streamDesired),
    lastTestOk: Boolean(raw.lastTestOk ?? current.lastTestOk),
    lastTestAt: String(raw.lastTestAt ?? current.lastTestAt ?? ''),
    lastTestMessage: String(raw.lastTestMessage ?? current.lastTestMessage ?? ''),
    lastTestStatus: String(raw.lastTestStatus ?? current.lastTestStatus ?? ''),
    lastTestTarget: String(raw.lastTestTarget ?? current.lastTestTarget ?? '')
  };
}

function normalizeFaceDeviceType(value) {
  const type = String(value || '').trim().toLowerCase();
  return ['hikvision', 'dahua'].includes(type) ? type : '';
}

function normalizeFaceDeviceId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 80);
}

function normalizeOperatorVersion(value) {
  const raw = String(value || 'live').trim().replace(/^version-/, '');
  if (!raw) return 'live';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(raw)) {
    throw validationError('La rama de EOLO Cloud solo puede contener letras, numeros, guion y guion bajo');
  }
  return raw;
}

function normalizeOperatorDeviceId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  if (!normalized) throw validationError('El identificador de dispositivo no es valido');
  return normalized;
}

function normalizeOperatorSerialNumber(value) {
  return String(value || '')
    .trim()
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function intInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
