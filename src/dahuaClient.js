import fs from 'node:fs';
import DigestFetch from 'digest-fetch';
import { config, deviceBaseUrl } from './config.js';

export class DahuaClient {
  constructor(settings = config.dahua) {
    this.settings = settings;
    this.baseUrl = deviceBaseUrl(settings);
  }

  digestClient() {
    return new DigestFetch(this.settings.username, this.settings.password, {
      algorithm: 'MD5'
    });
  }

  async request(pathname, options = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const digest = this.digestClient();
    const response = await digest.fetch(url, this.buildRequestOptions(options));
    const text = await response.text();
    if (!response.ok || /^Error/i.test(text.trim())) {
      const endpoint = pathname.split('?')[0];
      const error = new Error(`Dahua ${response.status} ${response.statusText} (${endpoint})`.trim());
      error.status = response.status;
      error.body = text;
      error.path = pathname;
      throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') || /^[\s\r\n]*[{\[]/.test(text)) {
      return JSON.parse(text || '{}');
    }
    return parseDahuaText(text);
  }

  async stream(pathname, options = {}) {
    const digest = this.digestClient();
    const response = await digest.fetch(`${this.baseUrl}${pathname}`, this.buildRequestOptions(options));
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`Dahua stream ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return response;
  }

  async deviceInfo(options = {}) {
    const [system, version] = await Promise.all([
      this.request('/cgi-bin/magicBox.cgi?action=getSystemInfo', options),
      this.request('/cgi-bin/magicBox.cgi?action=getSoftwareVersion', options).catch(() => ({}))
    ]);
    assertDahuaSystemInfo(system);
    return {
      DeviceInfo: {
        deviceName: system.deviceType || system.serialNumber || this.settings.bridgeIdentifier,
        model: system.deviceType || 'Dahua ASI',
        serialNumber: system.serialNumber || system.sn || '',
        firmwareVersion: version.version || version.Version || '',
        ipAddress: this.settings.host,
        vendor: 'Dahua'
      },
      raw: { system, version }
    };
  }

  async capabilities(options = {}) {
    const eventCaps = await this.request('/cgi-bin/eventManager.cgi?action=getCaps', options).catch((error) => ({
      error: error.message
    }));
    return {
      isSupportCgi: true,
      isSupportAccessControl: true,
      isSupportFaceInfoManager: true,
      isSupportEventManager: !eventCaps.error,
      eventCaps
    };
  }

  async createEmployee(employee) {
    return this.upsertEmployee(employee, { action: 'insert' });
  }

  async updateEmployee(employeeNo, employee) {
    const existing = await this.findEmployee(employeeNo).catch(() => null);
    if (!existing?.RecNo && !existing?.recNo) {
      return this.createEmployee({ ...employee, employeeNo });
    }
    return this.upsertEmployee({ ...employee, employeeNo, recNo: existing.RecNo || existing.recNo }, {
      action: 'update'
    });
  }

  async deleteEmployee(employeeNo, employee = {}) {
    const existing = employee?.RecNo || employee?.recNo || employee?.raw?.RecNo || employee?.raw?.recNo
      ? employee
      : await this.findEmployee(employeeNo).catch(() => null);
    const recNo = existing?.RecNo || existing?.recNo;
    if (recNo) {
      return this.request(
        `/cgi-bin/recordUpdater.cgi?${toQuery({
          action: 'remove',
          name: 'AccessControlCard',
          recno: recNo
        })}`
      );
    }
    const error = new Error(`No se encontro RecNo Dahua para eliminar UserID ${employeeNo}`);
    error.status = 404;
    throw error;
  }

  async searchEmployees({ employeeNo, maxResults = 30, position = 0 } = {}) {
    if (employeeNo) {
      const employee = await this.findEmployee(employeeNo).catch(() => null);
      return toDahuaSearchResult(employee ? [employee] : [], employee ? 1 : 0);
    }

    const count = Math.min(Number(maxResults) || 30, 100);
    const offset = Number(position) || 0;
    const attendance = await this.request(
      `/cgi-bin/Attendance.cgi?${toQuery({ action: 'findUser', Offset: offset, Count: count })}`
    ).catch(() => null);
    if (attendance?.UserInfo) {
      const users = Array.isArray(attendance.UserInfo) ? attendance.UserInfo : [attendance.UserInfo];
      return toDahuaSearchResult(users.map(normalizeAttendanceUser), Number(attendance.Total ?? users.length));
    }

    const records = await this.findAccessControlCards({ count, offset });
    return toDahuaSearchResult(records.records, records.total);
  }

  async findEmployee(employeeNo) {
    const attendance = await this.request(
      `/cgi-bin/Attendance.cgi?${toQuery({ action: 'getUser', UserID: employeeNo })}`
    ).catch(() => null);
    if (attendance?.UserInfo) return normalizeAttendanceUser(attendance.UserInfo);

    const records = await this.findAccessControlCards({ userId: employeeNo, count: 10, offset: 0 });
    const exactMatch = records.records.find((record) => String(record.UserID || record.employeeNo) === String(employeeNo));
    if (exactMatch) return exactMatch;

    const normalizedEmployeeNo = normalizeDahuaId(employeeNo);
    const page = await this.findAccessControlCards({ count: 100, offset: 0 }).catch(() => ({ records: [] }));
    return page.records.find((record) => normalizeDahuaId(record.UserID || record.employeeNo) === normalizedEmployeeNo);
  }

  async findAccessControlCards({ userId = '', count = 30, offset = 0 } = {}) {
    const params = {
      action: 'find',
      name: 'AccessControlCard',
      count,
      offset
    };
    if (userId) params['condition.UserID'] = userId;
    const payload = await this.request(`/cgi-bin/recordFinder.cgi?${toQuery(params)}`);
    const records = dahuaRecords(payload.records || payload.record || payload);
    return {
      records: records.map(normalizeAccessCardRecord),
      total: Number(payload.totalCount ?? payload.found ?? records.length)
    };
  }

  async upsertEmployee(employee, { action }) {
    const payload = this.toAccessControlCard(employee);
    const endpoint = action === 'update' ? 'update' : 'insert';
    const result = await this.request(
      `/cgi-bin/recordUpdater.cgi?${toQuery({
        action: endpoint,
        name: 'AccessControlCard',
        ...payload
      })}`
    );
    const recNo = result.RecNo || result.recNo || payload.recNo;
    return {
      ok: true,
      statusString: 'OK',
      RecNo: recNo,
      dahua: true,
      payload
    };
  }

  async uploadFace(employeeNo, filePath, metadata = {}) {
    const image = await fs.promises.readFile(filePath);
    const photoData = image.toString('base64');
    const body = {
      UserID: String(employeeNo),
      Info: {
        UserName: metadata.name || `Empleado ${employeeNo}`,
        PhotoData: [photoData]
      }
    };
    const add = await this.request('/cgi-bin/FaceInfoManager.cgi?action=add', {
      method: 'POST',
      body: JSON.stringify(body)
    }).catch(async (error) => {
      if (!/exist|already|Error/i.test(String(error.body || error.message))) throw error;
      return this.request('/cgi-bin/FaceInfoManager.cgi?action=update', {
        method: 'POST',
        body: JSON.stringify(body)
      });
    });
    return { ok: true, statusString: 'OK', dahua: true, result: add };
  }

  buildRequestOptions(options) {
    return {
      ...options,
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    };
  }

  toAccessControlCard(employee) {
    const now = new Date();
    const end = new Date(now.getFullYear() + Number(this.settings.validYears || 10), now.getMonth(), now.getDate(), 23, 59, 59);
    const payload = {
      ...(employee.recNo ? { recno: employee.recNo } : {}),
      CardName: String(employee.name || `Empleado ${employee.employeeNo}`).slice(0, 32),
      CardNo: String(employee.cardNo || employee.employeeNo),
      UserID: String(employee.employeeNo),
      CardStatus: 0,
      CardType: Number(employee.cardType ?? this.settings.cardType ?? 0),
      Password: employee.password || '',
      IsValid: employee.enable === false ? 'false' : 'true',
      ValidDateStart: formatDahuaDate(now),
      ValidDateEnd: formatDahuaDate(end),
      'Doors[0]': Number(employee.doorNo ?? this.settings.doorNo ?? 0)
    };
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== ''));
  }
}

function assertDahuaSystemInfo(system = {}) {
  const keys = Object.keys(system).filter((key) => key !== 'records');
  if (!keys.length || system.ok === true) {
    throw new Error('La respuesta Dahua no contiene informacion de sistema.');
  }
}

function toDahuaSearchResult(records, total) {
  return {
    UserInfoSearch: {
      responseStatusStrg: 'OK',
      numOfMatches: records.length,
      totalMatches: Number(total ?? records.length),
      UserInfo: records.map((record) => ({
        employeeNo: String(record.UserID || record.employeeNo || ''),
        employeeNoString: String(record.UserID || record.employeeNo || ''),
        name: record.CardName || record.UserName || record.name || '',
        userType: 'normal',
        cardNo: record.CardNo || '',
        RecNo: record.RecNo || record.recNo || '',
        doorNo: record.Door || record.Doors?.[0] || '',
        dahua: true,
        raw: record
      }))
    },
    dahua: true
  };
}

function normalizeAttendanceUser(user = {}) {
  return {
    UserID: String(user.UserID ?? user.userId ?? ''),
    UserName: user.UserName || user.name || '',
    CardName: user.UserName || user.name || '',
    CardNo: user.CardNo || '',
    Password: user.Password || ''
  };
}

function normalizeAccessCardRecord(record = {}) {
  return {
    ...record,
    UserID: String(record.UserID ?? record.userId ?? record.employeeNo ?? ''),
    CardName: record.CardName || record.UserName || record.name || '',
    CardNo: record.CardNo || '',
    RecNo: record.RecNo || record.recNo || record.recordNo || ''
  };
}

function parseDahuaText(text = '') {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'OK') return { ok: true };
  const result = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index === -1) continue;
    result[line.slice(0, index)] = coerceDahuaValue(line.slice(index + 1));
  }
  result.records = dahuaRecords(result);
  return result;
}

function dahuaRecords(payload = {}) {
  if (Array.isArray(payload)) return payload;
  const records = [];
  for (const [key, value] of Object.entries(payload)) {
    const match = key.match(/^(?:records?|items?)\[(\d+)\]\.([^=]+)$/i);
    if (!match) continue;
    const index = Number(match[1]);
    records[index] = records[index] || {};
    records[index][match[2]] = value;
  }
  return records.filter(Boolean);
}

function coerceDahuaValue(value) {
  const text = String(value ?? '').trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function formatDahuaDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function normalizeDahuaId(value) {
  return String(value || '').trim().replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
