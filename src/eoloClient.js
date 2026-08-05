import { config } from './config.js';
import { log } from './logger.js';

export class EoloClient {
  constructor() {
    this.enabled = Boolean(config.eolo.baseUrl);
  }

  endpoint(path) {
    return new URL(path, config.eolo.baseUrl).toString();
  }

  userSyncEndpoint() {
    const endpoint = config.eolo.userSyncEndpoint;
    const base = endpoint.startsWith('http') ? undefined : config.eolo.baseUrl || 'https://eolo.app';
    const url = new URL(endpoint, base);
    url.searchParams.set('acceso', config.eolo.access);
    url.searchParams.set('dispositivo', config.hikvision.localDeviceId);
    return url.toString();
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      ...(config.eolo.token ? { Authorization: `Bearer ${config.eolo.token}` } : {})
    };
  }

  async sendEvent(event) {
    if (!this.enabled) return { skipped: true };

    const response = await fetch(this.endpoint(config.eolo.eventEndpoint), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`EOLO event sync failed: ${response.status} ${body}`);
    }

    await log('info', 'Evento enviado a EOLO', {
      employeeNo: event.employeeNo,
      serialNo: event.serialNo
    });
    return response.json().catch(() => ({ ok: true }));
  }

  async fetchTasks() {
    if (!this.enabled || !config.eolo.pollEnabled) return [];

    const response = await fetch(this.endpoint(config.eolo.tasksEndpoint), {
      headers: this.headers()
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`EOLO task poll failed: ${response.status} ${body}`);
    }

    const payload = await response.json().catch(() => []);
    if (Array.isArray(payload)) return payload;
    return payload.tasks || [];
  }

  async fetchAccessPermissions() {
    if (!config.eolo.access) {
      const error = new Error('El parametro acceso de EOLO es obligatorio para sincronizar usuarios.');
      error.status = 400;
      throw error;
    }
    if (!config.hikvision.localDeviceId) {
      const error = new Error('El ID del dispositivo local es obligatorio para sincronizar usuarios EOLO.');
      error.status = 400;
      throw error;
    }
    if (!config.eolo.token) {
      const error = new Error('El token Bearer de EOLO es obligatorio para sincronizar usuarios.');
      error.status = 400;
      throw error;
    }

    const response = await fetch(this.userSyncEndpoint(), {
      method: 'GET',
      headers: this.headers()
    });

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      const error = new Error(`EOLO user sync failed: ${response.status} ${body}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    const payload = body ? JSON.parse(body) : {};
    if (payload.status && payload.status !== 'success') {
      const error = new Error(`EOLO respondio estado ${payload.status}`);
      error.body = payload;
      throw error;
    }

    return (
      payload.response?.['acceso-residentes'] ||
      payload['acceso-residentes'] ||
      payload.response?.['permisos-acceso'] ||
      payload['permisos-acceso'] ||
      []
    );
  }

  async ackTask(taskId, result) {
    if (!this.enabled || !taskId) return { skipped: true };

    const response = await fetch(this.endpoint(`${config.eolo.taskAckEndpoint}/${taskId}/ack`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(result)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`EOLO task ack failed: ${response.status} ${body}`);
    }

    return response.json().catch(() => ({ ok: true }));
  }
}
