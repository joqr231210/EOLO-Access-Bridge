export class ServiceManager {
  constructor() {
    this.services = new Map();
  }

  register(service) {
    if (!service?.id) throw new Error('El servicio requiere id');
    this.services.set(service.id, service);
  }

  async list() {
    const services = [];
    for (const service of this.services.values()) {
      services.push(await this.describe(service));
    }
    return services;
  }

  async describe(serviceOrId) {
    const service =
      typeof serviceOrId === 'string' ? this.get(serviceOrId) : serviceOrId;
    const status = await service.status();
    return {
      id: service.id,
      name: service.name,
      group: service.group || 'local',
      description: service.description || '',
      controllable: service.controllable !== false,
      ...status
    };
  }

  get(id) {
    const service = this.services.get(id);
    if (!service) {
      const error = new Error(`Servicio no encontrado: ${id}`);
      error.status = 404;
      throw error;
    }
    return service;
  }

  async start(id) {
    const service = this.get(id);
    if (service.controllable === false) {
      const error = new Error(`Servicio no controlable: ${id}`);
      error.status = 400;
      throw error;
    }
    await service.start();
    return this.describe(service);
  }

  async stop(id) {
    const service = this.get(id);
    if (service.controllable === false) {
      const error = new Error(`Servicio no controlable: ${id}`);
      error.status = 400;
      throw error;
    }
    await service.stop();
    return this.describe(service);
  }

  async restart(id) {
    const service = this.get(id);
    if (service.controllable === false) {
      const error = new Error(`Servicio no controlable: ${id}`);
      error.status = 400;
      throw error;
    }
    if (typeof service.restart === 'function') {
      await service.restart();
    } else {
      await service.stop();
      await service.start();
    }
    return this.describe(service);
  }
}

export function remoteAnprService({ id, name, baseUrl, remoteId = id, description }) {
  return {
    id,
    name,
    group: 'anpr',
    description,
    async status() {
      try {
        const response = await fetchJson(`${baseUrl}/api/services`);
        const service = response.services?.find((item) => item.id === remoteId);
        return normalizeRemoteStatus(service);
      } catch (error) {
        return {
          running: false,
          status: 'unreachable',
          error: error.message
        };
      }
    },
    start: () => postRemoteAction(baseUrl, remoteId, 'start'),
    stop: () => postRemoteAction(baseUrl, remoteId, 'stop'),
    restart: () => postRemoteAction(baseUrl, remoteId, 'restart')
  };
}

async function postRemoteAction(baseUrl, remoteId, action) {
  await fetchJson(`${baseUrl}/api/services/${remoteId}/${action}`, {
    method: 'POST'
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3000),
    ...options
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function normalizeRemoteStatus(service) {
  if (!service) {
    return {
      running: false,
      status: 'unknown',
      error: 'Servicio remoto no reportado'
    };
  }
  return {
    running: Boolean(service.running),
    status: service.running ? 'running' : 'stopped',
    pid: service.pid,
    exitCode: service.exitCode,
    startedAt: service.startedAt
  };
}
