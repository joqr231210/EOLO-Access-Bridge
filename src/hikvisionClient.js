import fs from 'node:fs';
import DigestFetch from 'digest-fetch';
import FormData from 'form-data';
import { config, deviceBaseUrl } from './config.js';

export class HikvisionClient {
  constructor(settings = config.hikvision) {
    this.settings = settings;
    this.baseUrl = deviceBaseUrl(settings);
  }

  digestClient() {
    return new DigestFetch(this.settings.username, this.settings.password, {
      algorithm: 'MD5'
    });
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const digest = this.digestClient();
    const initialOptions = this.buildRequestOptions(options);
    const response = await digest.fetch(url, {
      ...initialOptions,
      factory: () => this.buildRequestOptions(options)
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Hikvision ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return JSON.parse(text || '{}');
    return text;
  }

  async stream(path, options = {}) {
    const digest = this.digestClient();
    const initialOptions = this.buildRequestOptions(options);
    const response = await digest.fetch(`${this.baseUrl}${path}`, {
      ...initialOptions,
      factory: () => this.buildRequestOptions(options)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`Hikvision stream ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return response;
  }

  deviceInfo(options = {}) {
    return this.request('/ISAPI/System/deviceInfo', options);
  }

  capabilities(options = {}) {
    return this.request('/ISAPI/System/capabilities', options);
  }

  createEmployee(employee) {
    return this.request('/ISAPI/AccessControl/UserInfo/Record?format=json', {
      method: 'POST',
      body: JSON.stringify({ UserInfo: this.toUserInfo(employee) })
    });
  }

  searchEmployees({ employeeNo, maxResults = 30, position = 0, searchID } = {}) {
    const condition = {
      searchID: searchID || `eolo-${Date.now()}`,
      searchResultPosition: Number(position) || 0,
      maxResults: Number(maxResults) || 30
    };
    if (employeeNo) {
      condition.EmployeeNoList = [{ employeeNo: String(employeeNo) }];
    }

    return this.request('/ISAPI/AccessControl/UserInfo/Search?format=json', {
      method: 'POST',
      body: JSON.stringify({ UserInfoSearchCond: condition })
    });
  }

  updateEmployee(employeeNo, employee) {
    return this.request('/ISAPI/AccessControl/UserInfo/Modify?format=json', {
      method: 'PUT',
      body: JSON.stringify({
        UserInfo: this.toUserInfo({ ...employee, employeeNo })
      })
    });
  }

  deleteEmployee(employeeNo) {
    return this.request('/ISAPI/AccessControl/UserInfo/Delete?format=json', {
      method: 'PUT',
      body: JSON.stringify({
        UserInfoDelCond: {
          EmployeeNoList: [{ employeeNo: String(employeeNo) }]
        }
      })
    });
  }

  async uploadFace(employeeNo, filePath, metadata = {}) {
    const faceRecord = {
      faceLibType: metadata.faceLibType || this.settings.faceLibType,
      FDID: metadata.fdid || this.settings.fdid,
      FPID: String(employeeNo)
    };
    const multipart = await this.buildFaceMultipart(filePath, {
      faceRecord,
      filename: metadata.originalName || `${employeeNo}.jpg`,
      mimeType: metadata.mimeType || 'image/jpeg'
    });

    return this.request('/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json', {
      method: 'POST',
      body: multipart.body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
        'Content-Length': String(multipart.body.length)
      }
    });
  }

  async buildFaceMultipart(filePath, { faceRecord, filename, mimeType }) {
    const boundary = `----eolo-hikvision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const image = await fs.promises.readFile(filePath);
    const json = JSON.stringify(faceRecord);
    const head = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="FaceDataRecord"',
        'Content-Type: application/json',
        '',
        json,
        `--${boundary}`,
        `Content-Disposition: form-data; name="FaceImage"; filename="${sanitizeFilename(filename)}"`,
        `Content-Type: ${mimeType}`,
        '',
        ''
      ].join('\r\n'),
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return {
      boundary,
      body: Buffer.concat([head, image, tail]),
      faceRecord
    };
  }

  buildRequestOptions(options) {
    const raw = typeof options.factory === 'function' ? options.factory() : { ...options };
    delete raw.factory;
    return {
      ...raw,
      headers: {
        Accept: 'application/json, application/xml, text/plain, */*',
        ...(raw.body && !(raw.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(raw.headers || {})
      }
    };
  }

  toUserInfo(employee) {
    const now = new Date();
    const defaultBegin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const defaultEnd = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate(), 23, 59, 59);

    const beginTime = employee.beginTime || localDateTime(defaultBegin);
    const endTime = employee.endTime || localDateTime(defaultEnd);
    const doorNo = Number(employee.doorNo || this.settings.doorNo);
    const planTemplateNo = String(employee.planTemplateNo || this.settings.planTemplateNo);

    return {
      employeeNo: String(employee.employeeNo),
      name: employee.name || `Empleado ${employee.employeeNo}`,
      userType: employee.userType || 'normal',
      Valid: {
        enable: employee.enable !== false,
        beginTime,
        endTime,
        timeType: employee.timeType || 'local'
      },
      doorRight: String(doorNo),
      RightPlan: [
        {
          doorNo,
          planTemplateNo
        }
      ]
    };
  }
}

function localDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sanitizeFilename(filename) {
  return String(filename || 'face.jpg').replace(/["\r\n]/g, '_');
}
