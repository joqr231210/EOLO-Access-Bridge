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
  },
  operator: {
    pin: process.env.EOLO_OPERATOR_PIN || '1234',
    smsCode: process.env.EOLO_OPERATOR_SMS_CODE || '2468',
    appBaseUrl: (process.env.EOLO_OPERATOR_APP_BASE_URL || 'https://eolo.app').replace(/\/+$/, ''),
    appVersion: process.env.EOLO_OPERATOR_VERSION || 'live',
    authMode: process.env.EOLO_OPERATOR_AUTH_MODE || 'cloud',
    loginEndpoint: process.env.EOLO_OPERATOR_LOGIN_ENDPOINT || 'apk_login',
    smsLoginEndpoint: process.env.EOLO_OPERATOR_SMS_LOGIN_ENDPOINT || '',
    accessesEndpoint: process.env.EOLO_OPERATOR_ACCESSES_ENDPOINT || 'bridge_operator_accesses',
    accessesMethod: process.env.EOLO_OPERATOR_ACCESSES_METHOD || 'GET',
    controlPointsEndpoint:
      process.env.EOLO_OPERATOR_CONTROL_POINTS_ENDPOINT || 'bridge_operator_control_points',
    controlPointsMethod: process.env.EOLO_OPERATOR_CONTROL_POINTS_METHOD || 'GET',
    movementsEndpoint: process.env.EOLO_OPERATOR_MOVEMENTS_ENDPOINT || 'bridge_operator_movements_today',
    movementsMethod: process.env.EOLO_OPERATOR_MOVEMENTS_METHOD || 'GET',
    residentsEndpoint: process.env.EOLO_OPERATOR_RESIDENTS_ENDPOINT || 'bridge_operator_residents',
    residentsMethod: process.env.EOLO_OPERATOR_RESIDENTS_METHOD || 'GET',
    plateProfileEndpoint:
      process.env.EOLO_OPERATOR_PLATE_PROFILE_ENDPOINT || 'bridge_operator_plate_profile',
    plateProfileMethod: process.env.EOLO_OPERATOR_PLATE_PROFILE_METHOD || 'GET',
    createMovementEndpoint:
      process.env.EOLO_OPERATOR_CREATE_MOVEMENT_ENDPOINT || 'bridge_operator_create_movement',
    createMovementMethod: process.env.EOLO_OPERATOR_CREATE_MOVEMENT_METHOD || 'POST',
    egressMovementEndpoint:
      process.env.EOLO_OPERATOR_EGRESS_MOVEMENT_ENDPOINT || 'bridge_operator_egress_movement',
    egressMovementMethod: process.env.EOLO_OPERATOR_EGRESS_MOVEMENT_METHOD || 'POST',
    fileUploadEndpoint: process.env.EOLO_OPERATOR_FILE_UPLOAD_ENDPOINT || 'fileupload',
    attachIdentificationEndpoint:
      process.env.EOLO_OPERATOR_ATTACH_IDENTIFICATION_ENDPOINT ||
      'bridge_operator_attach_identification_photo',
    attachIdentificationMethod: process.env.EOLO_OPERATOR_ATTACH_IDENTIFICATION_METHOD || 'POST',
    cloudStatusEndpoint: process.env.EOLO_OPERATOR_CLOUD_STATUS_ENDPOINT || 'bridge_operator_ping',
    cloudStatusMethod: process.env.EOLO_OPERATOR_CLOUD_STATUS_METHOD || 'GET',
    deviceHeartbeatEnabled: boolFromEnv('EOLO_OPERATOR_DEVICE_HEARTBEAT_ENABLED', true),
    deviceHeartbeatEndpoint:
      process.env.EOLO_OPERATOR_DEVICE_HEARTBEAT_ENDPOINT || 'bridge_operator_device_heartbeat',
    deviceHeartbeatMethod: process.env.EOLO_OPERATOR_DEVICE_HEARTBEAT_METHOD || 'POST',
    deviceDataType: process.env.EOLO_OPERATOR_DEVICE_DATA_TYPE || 'dispositivosacceso',
    deviceId: process.env.EOLO_OPERATOR_DEVICE_ID || '',
    defaultName: process.env.EOLO_OPERATOR_NAME || 'Operador EOLO',
    defaultCompany: process.env.EOLO_OPERATOR_COMPANY || 'TRACSA',
    defaultAccessName: process.env.EOLO_OPERATOR_ACCESS_NAME || 'Caseta Periferico',
    syncIntervalMs: intFromEnv('EOLO_OPERATOR_SYNC_INTERVAL_MINUTES', 5) * 60 * 1000
  },
  openaiVision: {
    enabled: boolFromEnv('OPENAI_VISION_ENABLED', false),
    apiKey: process.env.OPENAI_VISION_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
    timeoutMs: intFromEnv('OPENAI_VISION_TIMEOUT_SECONDS', 18) * 1000
  },
  anpr: {
    baseUrl: process.env.ANPR_API_BASE_URL || 'http://127.0.0.1:8090',
    streamPublicUrl: (
      process.env.ANPR_STREAM_PUBLIC_URL ||
      `http://localhost:${process.env.ANPR_STREAM_HOST_PORT || 8083}`
    ).replace(/\/+$/, ''),
    webrtcEnabled: boolFromEnv('ANPR_WEBRTC_ENABLED', true),
    webrtcAutostart: boolFromEnv('ANPR_WEBRTC_AUTOSTART', false),
    webrtcApiUrl: (process.env.ANPR_WEBRTC_API_URL || 'http://127.0.0.1:1984').replace(/\/+$/, ''),
    webrtcPublicUrl: (
      process.env.ANPR_WEBRTC_PUBLIC_URL ||
      `http://localhost:${process.env.ANPR_WEBRTC_HOST_PORT || 1984}`
    ).replace(/\/+$/, ''),
    webrtcIceHost: process.env.ANPR_WEBRTC_ICE_HOST || '',
    webrtcPort: intFromEnv('ANPR_WEBRTC_PORT', 8555),
    go2rtcBinary: process.env.GO2RTC_BINARY || '/usr/local/bin/go2rtc',
    go2rtcConfigFile: process.env.GO2RTC_CONFIG_FILE || path.resolve(process.env.DATA_DIR || './data', 'go2rtc.yaml')
  }
};

export const deviceBaseUrl = (settings = config.hikvision) => {
  const defaultPort =
    (settings.protocol === 'http' && settings.port === 80) ||
    (settings.protocol === 'https' && settings.port === 443);
  const port = defaultPort ? '' : `:${settings.port}`;
  return `${settings.protocol}://${settings.host}${port}`;
};
