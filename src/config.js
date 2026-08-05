import 'dotenv/config';
import path from 'node:path';

const intFromEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

const boolFromEnv = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

export const config = {
  port: intFromEnv('PORT', 8080),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  mockDevice: boolFromEnv('MOCK_DEVICE', true),
  hikvision: {
    bridgeIdentifier: process.env.BRIDGE_IDENTIFIER || 'Nuevo Dispositivo Bridge',
    localDeviceId: process.env.LOCAL_DEVICE_ID || '',
    protocol: process.env.HIKVISION_PROTOCOL || 'http',
    host: process.env.HIKVISION_HOST || '192.168.1.77',
    port: intFromEnv('HIKVISION_PORT', 80),
    username: process.env.HIKVISION_USERNAME || 'admin',
    password: process.env.HIKVISION_PASSWORD || '',
    doorNo: intFromEnv('HIKVISION_DOOR_NO', 1),
    planTemplateNo: process.env.HIKVISION_PLAN_TEMPLATE_NO || '1',
    fdid: process.env.HIKVISION_FDID || '1',
    faceLibType: process.env.HIKVISION_FACE_LIB_TYPE || 'blackFD',
    dedupWindowMs: intFromEnv('HIKVISION_DEDUP_WINDOW_SECONDS', 8) * 1000
  },
  eolo: {
    baseUrl: process.env.EOLO_API_BASE_URL || '',
    token: process.env.EOLO_API_TOKEN || '',
    eventEndpoint: process.env.EOLO_EVENT_ENDPOINT || '/api/device-events',
    tasksEndpoint: process.env.EOLO_TASKS_ENDPOINT || '/api/local-agent/tasks',
    taskAckEndpoint: process.env.EOLO_TASK_ACK_ENDPOINT || '/api/local-agent/tasks',
    pollEnabled: boolFromEnv('EOLO_POLL_ENABLED', false),
    pollIntervalMs: intFromEnv('EOLO_POLL_INTERVAL_SECONDS', 30) * 1000,
    userSyncEnabled: boolFromEnv('EOLO_USER_SYNC_ENABLED', false),
    userSyncEndpoint:
      process.env.EOLO_USER_SYNC_ENDPOINT ||
      'https://eolo.app/version-test/api/1.1/wf/permisos-acceso',
    access: process.env.EOLO_ACCESS || '',
    userSyncIntervalMs: intFromEnv('EOLO_USER_SYNC_INTERVAL_MINUTES', 30) * 60 * 1000
  }
};

export const deviceBaseUrl = (settings = config.hikvision) => {
  const defaultPort =
    (settings.protocol === 'http' && settings.port === 80) ||
    (settings.protocol === 'https' && settings.port === 443);
  const port = defaultPort ? '' : `:${settings.port}`;
  return `${settings.protocol}://${settings.host}${port}`;
};
