import crypto from 'node:crypto';

export function operatorId2DeviceCode(deviceId) {
  const hash = crypto.createHash('sha256').update(deviceId).digest();
  const value = hash.readUInt16BE(0) % 1296;
  return value.toString(36).toUpperCase().padStart(2, '0');
}
