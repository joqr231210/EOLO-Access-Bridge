import { config } from './config.js';
import { normalizeWorkflowEndpoint } from './eoloWorkflow.js';
import { log } from './logger.js';

export class EoloClient {
  constructor() {
    this.enabled = Boolean(config.eolo.baseUrl);
  }

  endpoint(path) {
    return new URL(path, config.eolo.baseUrl).toString();
  }

  userSyncEndpoint(options = {}) {
    const endpoint = normalizeWorkflowEndpoint(config.eolo.userSyncEndpoint);
    const version = String(config.operator.appVersion || 'live').replace(/^version-/, '');
    const versionPath = version === 'live' ? '' : `/version-${version}`;
    const workflowBaseUrl = `${config.operator.appBaseUrl}${versionPath}/api/1.1/wf`;
    const url = new URL(`${workflowBaseUrl}/${endpoint}`);
    url.searchParams.set('acceso', config.eolo.access);
    if (options.validAfter) {
      url.searchParams.set('valid_after', options.validAfter);
      url.searchParams.set('vigencia_final_after', options.validAfter);
    }
    return url.toString();
  }

  headers(options = {}) {
    const token = options.token || config.eolo.token;
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
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

  async fetchAccessPermissions(options = {}) {
    if (!config.eolo.access) {
      const error = new Error('El parametro acceso de EOLO es obligatorio para sincronizar usuarios.');
      error.status = 400;
      throw error;
    }
    const token = options.token || config.eolo.token;
    if (!token) {
      const error = new Error('El token Bearer de EOLO es obligatorio para sincronizar usuarios.');
      error.status = 400;
      throw error;
    }

    const validAfter = options.validAfter || new Date().toISOString();
    const url = this.userSyncEndpoint({ validAfter });
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.headers({ token }),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      const parsed = new URL(url);
      throw new Error(`No se pudo conectar con EOLO Cloud (${parsed.origin}): ${error.message}`);
    }

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
