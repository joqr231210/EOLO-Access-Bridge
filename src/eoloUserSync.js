import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

export class EoloUserSync {
  constructor(device, eoloClient, options = {}) {
    this.device = device;
    this.eoloClient = eoloClient;
    this.runHandler = options.runHandler || null;
    this.snapshotPath = path.join(config.dataDir, 'eolo-users-snapshot.json');
    this.timer = null;
    this.running = false;
    this.cloudRunning = false;
    this.deviceRunning = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.lastError = null;
    this.lastCloudRunAt = null;
    this.lastCloudResult = null;
    this.lastCloudError = null;
    this.lastDeviceRunAt = null;
    this.lastDeviceResult = null;
    this.lastDeviceError = null;
  }

  status() {
    const totalFaceDevices = Array.isArray(config.faceDevices) ? config.faceDevices.length : 0;
    const eligibleFaceDevices = (config.faceDevices || []).filter(
      (device) => device.enabled && device.lastTestOk
    ).length;
    return {
      enabled: config.eolo.userSyncEnabled,
      configured: Boolean(config.eolo.access && config.eolo.token),
      faceDevice: config.faceDevice,
      totalFaceDevices,
      eligibleFaceDevices,
      running: Boolean(this.timer || this.running),
      processing: this.running,
      intervalMinutes: Math.round(config.eolo.userSyncIntervalMs / 60000),
      endpoint: config.eolo.userSyncEndpoint,
      accessSet: Boolean(config.eolo.access),
      localDeviceIdSet: true,
      tokenSet: Boolean(config.eolo.token),
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      cloud: {
        running: this.cloudRunning,
        lastRunAt: this.lastCloudRunAt,
        lastResult: this.lastCloudResult,
        lastError: this.lastCloudError
      },
      device: {
        running: this.deviceRunning,
        lastRunAt: this.lastDeviceRunAt,
        lastResult: this.lastDeviceResult,
        lastError: this.lastDeviceError
      }
    };
  }

  start() {
    this.stop();
    if (!config.eolo.userSyncEnabled) return;

    const interval = Math.max(config.eolo.userSyncIntervalMs, 60 * 1000);
    this.timer = setInterval(() => {
      const runner = this.runHandler || ((options) => this.runOnce(options));
      runner({ scheduled: true }).catch((error) => {
        log('error', 'Fallo la sincronizacion de usuarios EOLO', {
          error: error.message,
          status: error.status,
          tokenSource: error.tokenSource
        }).catch(() => {});
      });
    }, interval);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  restart() {
    this.start();
  }

  async runOnce(options = {}) {
    if (this.running) {
      return { ok: true, skipped: true, reason: 'sync-running' };
    }
    this.running = true;
    this.lastError = null;
    const startedAt = new Date().toISOString();
    try {
      const cloud = await this.downloadFromCloud({ ...options, allowWhileFullRunning: true });
      const device = await this.applySnapshotToDevice({ allowWhileFullRunning: true });
      const result = {
        ok: true,
        startedAt,
        completedAt: new Date().toISOString(),
        cloud,
        device,
        cloudCount: cloud.cloudCount,
        validCloudCount: cloud.validCloudCount,
        existingDeviceCount: device.existingDeviceCount,
        created: device.created,
        updated: device.updated,
        deleted: device.deleted,
        facesUpdated: device.facesUpdated,
        skippedFaces: device.skippedFaces,
        skippedInvalid: cloud.skippedInvalid
      };
      this.lastRunAt = result.completedAt;
      this.lastResult = result;
      await log('info', 'Sincronizacion de usuarios EOLO completada', result);
      return result;
    } catch (error) {
      this.lastRunAt = new Date().toISOString();
      this.lastError = error.message;
      throw error;
    } finally {
      this.running = false;
    }
  }

  async downloadFromCloud(options = {}) {
    if (!config.eolo.userSyncEnabled) {
      const error = new Error('La sincronizacion de usuarios EOLO no esta activa.');
      error.status = 400;
      throw error;
    }
    if (!config.eolo.access) {
      const error = new Error('Configura el parametro acceso antes de sincronizar usuarios EOLO.');
      error.status = 400;
      throw error;
    }
    const token = options.token || config.eolo.token;
    if (!token) {
      const error = new Error('Configura el token Bearer antes de sincronizar usuarios EOLO.');
      error.status = 400;
      throw error;
    }
    if (this.cloudRunning || (this.running && !options.allowWhileFullRunning)) {
      return { ok: true, skipped: true, reason: 'cloud-sync-running' };
    }

    this.cloudRunning = true;
    this.lastCloudError = null;
    const startedAt = new Date().toISOString();

    try {
      await log('info', 'Descargando usuarios EOLO desde Cloud', {
        endpoint: config.eolo.userSyncEndpoint,
        accessSet: Boolean(config.eolo.access),
        usingOperatorToken: Boolean(options.token)
      });

      const validAfter = new Date();
      const permissions = await this.eoloClient.fetchAccessPermissions({ token, validAfter: validAfter.toISOString() });
      const downloadablePermissions = permissions.filter((permission) => isPermissionValidForDownload(permission, validAfter));
      const cloudEmployees = normalizePermissions(downloadablePermissions, { now: validAfter });
      const result = {
        ok: true,
        step: 'cloud',
        startedAt,
        completedAt: new Date().toISOString(),
        validAfter: validAfter.toISOString(),
        sourceCount: permissions.length,
        cloudCount: downloadablePermissions.length,
        validCloudCount: cloudEmployees.length,
        skippedExpired: permissions.length - downloadablePermissions.length,
        skippedInvalid: downloadablePermissions.length - cloudEmployees.length,
        snapshotFile: path.basename(this.snapshotPath)
      };

      await this.writeCloudSnapshot({ permissions: downloadablePermissions, employees: cloudEmployees, result });
      this.lastCloudRunAt = result.completedAt;
      this.lastCloudResult = result;
      await log('info', 'Descarga de usuarios EOLO completada', result);
      return result;
    } catch (error) {
      this.lastCloudRunAt = new Date().toISOString();
      this.lastCloudError = error.message;
      throw error;
    } finally {
      this.cloudRunning = false;
    }
  }

  async applySnapshotToDevice(options = {}) {
    if (this.deviceRunning || (this.running && !options.allowWhileFullRunning)) {
      return { ok: true, skipped: true, reason: 'device-sync-running' };
    }

    this.deviceRunning = true;
    this.lastDeviceError = null;
    const startedAt = new Date().toISOString();

    try {
      const snapshot = await this.readCloudSnapshot();
      const cloudEmployees = Array.isArray(snapshot.employees) ? snapshot.employees : [];
      const cloudByEmployeeNo = new Map(
        cloudEmployees.map((employee) => [employee.employeeNo, employee])
      );
      await log('info', 'Cargando snapshot EOLO al dispositivo facial', {
        faceDevice: config.faceDevice,
        snapshotAt: snapshot.downloadedAt,
        validCloudCount: cloudEmployees.length
      });

      const currentEmployees = await this.listAllEmployees();
      const currentByEmployeeNo = new Map(
        currentEmployees.map((employee) => [employeeId(employee), employee]).filter(([id]) => id)
      );

      const result = {
        ok: true,
        step: 'device',
        startedAt,
        completedAt: null,
        snapshotAt: snapshot.downloadedAt,
        validCloudCount: cloudEmployees.length,
        existingDeviceCount: currentEmployees.length,
        created: [],
        updated: [],
        deleted: [],
        facesUpdated: [],
        skippedFaces: []
      };

      for (const employee of cloudEmployees) {
        const deviceEmployee = employeeForDevice(employee, this.device.settings);
        const exists = currentByEmployeeNo.has(employee.employeeNo);
        if (exists) {
          await this.device.updateEmployee(employee.employeeNo, deviceEmployee);
          result.updated.push(employee.employeeNo);
        } else {
          await this.device.createEmployee(deviceEmployee);
          result.created.push(employee.employeeNo);
        }

        if (deviceEmployee.faceUrl) {
          try {
            await this.uploadFaceFromUrl(employee.employeeNo, deviceEmployee.faceUrl);
            result.facesUpdated.push(employee.employeeNo);
          } catch (error) {
            result.skippedFaces.push({ employeeNo: employee.employeeNo, error: error.message });
            await log('warn', 'No se pudo actualizar rostro EOLO', {
              employeeNo: employee.employeeNo,
              error: error.message
            });
          }
        }
      }

      for (const employee of currentEmployees) {
        const id = employeeId(employee);
        if (id && !cloudByEmployeeNo.has(id)) {
          await this.device.deleteEmployee(id, employee);
          result.deleted.push(id);
        }
      }

      result.completedAt = new Date().toISOString();
      this.lastDeviceRunAt = result.completedAt;
      this.lastDeviceResult = result;
      await log('info', 'Carga de usuarios EOLO al dispositivo completada', result);
      return result;
    } catch (error) {
      this.lastDeviceRunAt = new Date().toISOString();
      this.lastDeviceError = error.message;
      throw error;
    } finally {
      this.deviceRunning = false;
    }
  }

  async writeCloudSnapshot({ permissions, employees, result }) {
    await fs.promises.mkdir(config.dataDir, { recursive: true });
    const payload = {
      ok: true,
      downloadedAt: result.completedAt,
      access: result.access || config.eolo.access,
      endpoint: result.endpoint || config.eolo.userSyncEndpoint,
      sourceType: result.sourceType || 'workflow',
      sourceCount: Number.isFinite(Number(result.sourceCount)) ? Number(result.sourceCount) : permissions.length,
      validCount: employees.length,
      validAfter: result.validAfter || '',
      skippedExpired: result.skippedExpired || 0,
      skippedInvalid: result.skippedInvalid,
      employees,
      source: permissions
    };
    await fs.promises.writeFile(this.snapshotPath, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  async readCloudSnapshot() {
    try {
      return JSON.parse(await fs.promises.readFile(this.snapshotPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        const missing = new Error('No hay snapshot local de usuarios EOLO. Descarga primero desde Cloud.');
        missing.status = 400;
        throw missing;
      }
      throw error;
    }
  }

  async listAllEmployees() {
    const all = [];
    const pageSize = 50;
    let position = 0;
    let total = Infinity;

    while (position < total) {
      const result = await this.device.searchEmployees({ maxResults: pageSize, position });
      const normalized = normalizeEmployeeSearch(result);
      all.push(...normalized.employees);
      total = normalized.totalMatches || all.length;
      if (!normalized.employees.length || all.length >= total) break;
      position += normalized.employees.length;
    }

    return all;
  }

  async uploadFaceFromUrl(employeeNo, rawUrl) {
    const url = absoluteImageUrl(rawUrl);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Imagen rostro ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.includes('image/jpeg') && !contentType.includes('image/png')) {
      throw new Error(`Formato de imagen no soportado: ${contentType}`);
    }

    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const filePath = path.join(config.uploadDir, `eolo-${employeeNo}-${Date.now()}.${ext}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(filePath, bytes);

    try {
      return await this.device.uploadFace(employeeNo, filePath, {
        originalName: `${employeeNo}.${ext}`,
        mimeType: contentType.includes('png') ? 'image/png' : 'image/jpeg'
      });
    } finally {
      fs.promises.unlink(filePath).catch(() => {});
    }
  }
}

export function normalizePermissions(permissions, options = {}) {
  const now = parsePermissionDate(options.now) || new Date();
  return permissions
    .map((permission) => {
      if (permission.deleted === true || permission.deleted_boolean === true) return null;
      if (!isPermissionValidForDownload(permission, now)) return null;

      const employeeNo = normalizeDevicePermissionId2(
        permission.prefijopermisos_text ||
        permission.id2_text ||
        permission.ID2 ||
        permission.id2 ||
        permission.PermisoID2 ||
        permission.permiso_id2_text
      );
      if (!isCurrentDevicePermissionId2(employeeNo)) return null;

      return {
        employeeNo,
        name:
          permission.principal_name ||
          permission.user_name ||
          permission.NombrePrincipal ||
          permission.Nombre ||
          permission.NombreUsuario ||
          permission.nombreusuario_text ||
          permission.UsuarioNombre ||
          permission.Usuario ||
          permission.fullname_text ||
          `Residente ${employeeNo}`,
        doorNo: (config.faceDevice === 'dahua' ? config.dahua : config.hikvision).doorNo,
        planTemplateNo: config.hikvision.planTemplateNo,
        faceUrl:
          permission.Imagen ||
          permission.face_image ||
          permission.ImagenRostro ||
          permission.ImangenRostro ||
          permission.imangenrostro_image ||
          permission.imagen_image ||
          permission.imagenRostro ||
          permission.faceUrl ||
          '',
        sourcePermissionId: String(permission._id || permission.id || '').trim(),
        sourcePermissionId2: employeeNo
      };
    })
    .filter(Boolean);
}

export function isPermissionValidForDownload(permission = {}, now = new Date()) {
  const validUntil = parsePermissionDate(
    permission.valid_until ||
    permission.validity_end ||
    permission.VigenciaFinal ||
    permission['Vigencia Final'] ||
    permission.vigenciafinal_date ||
    permission.vigencia_final_date ||
    permission.raw?.vigenciafinal_date ||
    permission.raw?.vigencia_final_date ||
    permission.raw?.VigenciaFinal
  );
  if (!validUntil) return false;
  return validUntil.getTime() > now.getTime();
}

function parsePermissionDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{12,}$/.test(text)) return new Date(Number(text));
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000);
  const date = new Date(text.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeEmployeeSearch(result) {
  const search = result.UserInfoSearch || result.UserInfoSearchCond || result;
  const employees = search.UserInfo || search.userInfo || search.UserInfoList || [];
  const list = Array.isArray(employees) ? employees : [employees].filter(Boolean);
  return {
    employees: list,
    totalMatches: Number(search.totalMatches ?? search.numOfMatches ?? list.length ?? 0)
  };
}

function employeeForDevice(employee, settings = {}) {
  return {
    ...employee,
    doorNo: settings.doorNo ?? employee.doorNo,
    planTemplateNo: settings.planTemplateNo ?? employee.planTemplateNo
  };
}

function employeeId(employee) {
  return normalizeDevicePermissionId2(employee.employeeNo || employee.employeeNoString || '');
}

function absoluteImageUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function normalizeDevicePermissionId2(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 64);
}

function isCurrentDevicePermissionId2(value) {
  return /(?:VV|VR|PR|PV)\d{14}$/.test(normalizeDevicePermissionId2(value));
}
