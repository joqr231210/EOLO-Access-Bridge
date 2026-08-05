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
    }
  };
}

export function applyRuntimeConfig(input, { preservePassword }) {
  const current = config.hikvision;
  const currentEolo = config.eolo;
  const hikvision = input.hikvision || input;
  const eolo = input.eolo || {};
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

  return {
    mockDevice: config.mockDevice,
    hikvision: config.hikvision,
    eolo: config.eolo
  };
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
