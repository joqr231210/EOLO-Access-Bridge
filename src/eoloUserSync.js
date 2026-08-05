import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const EOLO_EMPLOYEE_ID = /^\d+x\d+$/;

export class EoloUserSync {
  constructor(device, eoloClient) {
    this.device = device;
    this.eoloClient = eoloClient;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.lastError = null;
  }

  status() {
    return {
      enabled: config.eolo.userSyncEnabled,
      configured: Boolean(config.eolo.access && config.eolo.token),
      running: this.running,
      intervalMinutes: Math.round(config.eolo.userSyncIntervalMs / 60000),
      endpoint: config.eolo.userSyncEndpoint,
      accessSet: Boolean(config.eolo.access),
      localDeviceIdSet: Boolean(config.hikvision.localDeviceId),
      tokenSet: Boolean(config.eolo.token),
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }

  start() {
    this.stop();
    if (!config.eolo.userSyncEnabled) return;

    const interval = Math.max(config.eolo.userSyncIntervalMs, 60 * 1000);
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        log('error', 'Fallo la sincronizacion de usuarios EOLO', { error: error.message }).catch(
          () => {}
        );
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

  async runOnce() {
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
    if (!config.hikvision.localDeviceId) {
      const error = new Error('Configura el ID del dispositivo local antes de sincronizar usuarios EOLO.');
      error.status = 400;
      throw error;
    }
    if (!config.eolo.token) {
      const error = new Error('Configura el token Bearer antes de sincronizar usuarios EOLO.');
      error.status = 400;
      throw error;
    }
    if (this.running) {
      return { ok: true, skipped: true, reason: 'sync-running' };
    }

    this.running = true;
    this.lastError = null;
    const startedAt = new Date().toISOString();

    try {
      await log('info', 'Sincronizando usuarios EOLO', {
        endpoint: config.eolo.userSyncEndpoint,
        accessSet: Boolean(config.eolo.access)
      });

      const permissions = await this.eoloClient.fetchAccessPermissions();
      const cloudEmployees = normalizePermissions(permissions);
      const cloudByEmployeeNo = new Map(
        cloudEmployees.map((employee) => [employee.employeeNo, employee])
      );
      const currentEmployees = await this.listAllEmployees();
      const currentByEmployeeNo = new Map(
        currentEmployees.map((employee) => [employeeId(employee), employee]).filter(([id]) => id)
      );

      const result = {
        ok: true,
        startedAt,
        cloudCount: permissions.length,
        validCloudCount: cloudEmployees.length,
        existingDeviceCount: currentEmployees.length,
        created: [],
        updated: [],
        deleted: [],
        facesUpdated: [],
        skippedFaces: [],
        skippedInvalid: permissions.length - cloudEmployees.length
      };

      for (const employee of currentEmployees) {
        const id = employeeId(employee);
        if (id && EOLO_EMPLOYEE_ID.test(id) && !cloudByEmployeeNo.has(id)) {
          await this.device.deleteEmployee(id);
          result.deleted.push(id);
        }
      }

      for (const employee of cloudEmployees) {
        const exists = currentByEmployeeNo.has(employee.employeeNo);
        if (exists) {
          await this.device.updateEmployee(employee.employeeNo, employee);
          result.updated.push(employee.employeeNo);
        } else {
          await this.device.createEmployee(employee);
          result.created.push(employee.employeeNo);
        }

        if (employee.faceUrl) {
          try {
            await this.uploadFaceFromUrl(employee.employeeNo, employee.faceUrl);
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

      this.lastRunAt = new Date().toISOString();
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

export function normalizePermissions(permissions) {
  return permissions
    .map((permission) => {
      if (permission.deleted === true) return null;

      const employeeNo = String(permission._id || permission.id || '').trim();
      if (!EOLO_EMPLOYEE_ID.test(employeeNo)) return null;

      return {
        employeeNo,
        name:
          permission.Nombre ||
          permission.NombreUsuario ||
          permission.UsuarioNombre ||
          permission.Usuario ||
          `Residente ${employeeNo}`,
        doorNo: config.hikvision.doorNo,
        planTemplateNo: config.hikvision.planTemplateNo,
        faceUrl:
          permission.Imagen ||
          permission.ImagenRostro ||
          permission.ImangenRostro ||
          permission.imagenRostro ||
          permission.faceUrl ||
          ''
      };
    })
    .filter(Boolean);
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

function employeeId(employee) {
  return String(employee.employeeNo || employee.employeeNoString || '').trim();
}

function absoluteImageUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}
