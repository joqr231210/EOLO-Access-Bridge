import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const runtimeConfigPath = () => path.join(config.dataDir, 'device-config.json');

export async function loadRuntimeConfig() {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await fs.promises.readFile(runtimeConfigPath(), 'utf8'));
    applyRuntimeConfig(saved, { preservePassword: false });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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
      syncIntervalMinutes: Math.round(config.operator.syncIntervalMs / 60000)
    }
  };
}

export function applyRuntimeConfig(input, { preservePassword }) {
  const current = config.hikvision;
  const currentEolo = config.eolo;
  const currentVision = config.openaiVision;
  const currentOperator = config.operator;
  const hikvision = input.hikvision || input;
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
  const userSyncEndpoint = String(eolo.userSyncEndpoint || currentEolo.userSyncEndpoint || '').trim();
  const userSyncIntervalMinutes =
    eolo.userSyncIntervalMinutes ??
    (eolo.userSyncIntervalMs ? Number(eolo.userSyncIntervalMs) / 60000 : undefined);

  if (!['http', 'https'].includes(protocol)) {
    throw validationError('protocol debe ser http o https');
  }
  if (!host) throw validationError('La IP o host del dispositivo es obligatorio');
  if (!username) throw validationError('El usuario de autenticacion es obligatorio');
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

  return {
    mockDevice: config.mockDevice,
    hikvision: config.hikvision,
    eolo: config.eolo,
    openaiVision: config.openaiVision,
    operator: config.operator
  };
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
