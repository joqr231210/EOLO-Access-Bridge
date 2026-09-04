import { config } from './config.js';
import { addEvent, log } from './logger.js';

const jsonFromMimePart = (part) => {
  const separator = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const body = part.includes(separator) ? part.slice(part.indexOf(separator) + separator.length) : part;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return JSON.parse(body.slice(start, end + 1));
};

const eventSummary = (rawEvent) => {
  const access = rawEvent.AccessControllerEvent || {};
  return {
    eventType: rawEvent.eventType,
    eventState: rawEvent.eventState,
    dateTime: rawEvent.dateTime,
    deviceName: access.deviceName,
    majorEventType: access.majorEventType,
    subEventType: access.subEventType,
    employeeNo: access.employeeNoString || access.employeeNo,
    name: access.name,
    serialNo: access.serialNo,
    frontSerialNo: access.frontSerialNo,
    doorNo: access.doorNo,
    cardReaderNo: access.cardReaderNo,
    currentVerifyMode: access.currentVerifyMode,
    userType: access.userType,
    mask: access.mask,
    raw: rawEvent
  };
};

export class DeviceEventStream {
  constructor(hikvisionClient, eoloClient, options = {}) {
    this.hikvisionClient = hikvisionClient;
    this.eoloClient = eoloClient;
    this.onAccessEvent = options.onAccessEvent || null;
    this.abortController = null;
    this.running = false;
    this.desired = false;
    this.retryTimer = null;
    this.seenSerials = new Set();
    this.lastEmployeeEvent = new Map();
  }

  async start() {
    if (this.running) return { running: true, alreadyRunning: true };
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.desired = true;

    this.abortController = new AbortController();
    this.running = true;
    await log('info', 'Iniciando stream de eventos Hikvision', {
      deviceId: this.hikvisionClient.settings.id,
      deviceName: this.hikvisionClient.settings.bridgeIdentifier,
      host: this.hikvisionClient.settings.host
    });
    const signal = this.abortController.signal;
    this.consume(signal).then(async () => {
      if (signal.aborted) return;
      await log('warn', 'Stream Hikvision finalizo sin error; se reintentara', {
        deviceId: this.hikvisionClient.settings.id
      });
      this.running = false;
      this.abortController = null;
      if (this.desired) this.scheduleReconnect();
    }).catch(async (error) => {
      const shouldReconnect = this.desired && error.name !== 'AbortError';
      if (error.name !== 'AbortError') {
        await log('error', 'Stream de eventos detenido por error', {
          error: error.message,
          body: error.body
        });
      }
      this.running = false;
      this.abortController = null;
      if (shouldReconnect) this.scheduleReconnect();
    });
    return { running: true };
  }

  stop() {
    this.desired = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.abortController) this.abortController.abort();
    this.abortController = null;
    this.running = false;
    log('info', 'Stream de eventos detenido', {
      deviceId: this.hikvisionClient.settings.id,
      deviceName: this.hikvisionClient.settings.bridgeIdentifier
    }).catch(() => {});
    return { running: false, device: 'hikvision', deviceId: this.hikvisionClient.settings.id };
  }

  status() {
    return {
      running: this.running,
      retrying: Boolean(this.retryTimer),
      device: 'hikvision',
      deviceId: this.hikvisionClient.settings.id
    };
  }

  scheduleReconnect() {
    if (!this.desired || this.retryTimer) return;
    const delayMs = Math.max(3000, Number(this.hikvisionClient.settings.reconnectDelayMs || 10000));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.desired || this.running) return;
      this.start().catch((error) => {
        log('error', 'No se pudo reintentar stream Hikvision', {
          error: error.message,
          deviceId: this.hikvisionClient.settings.id
        }).catch(() => {});
      });
    }, delayMs);
    this.retryTimer.unref?.();
  }

  async consume(signal) {
    const response = await this.hikvisionClient.stream('/ISAPI/Event/notification/alertStream', {
      signal
    });
    const contentType = response.headers.get('content-type') || '';
    const boundary = this.extractBoundary(contentType) || 'MIME_boundary';
    let buffer = '';

    for await (const chunk of response.body) {
      if (signal.aborted) break;
      buffer += Buffer.from(chunk).toString('utf8');

      const marker = `--${boundary}`;
      const parts = buffer.split(marker);
      buffer = parts.pop() || '';

      for (const part of parts) {
        await this.processPart(part);
      }

      if (buffer.length > 1024 * 1024) {
        buffer = buffer.slice(-1024 * 128);
        await log('warn', 'Buffer del stream recortado por exceso de tamano');
      }
    }
  }

  extractBoundary(contentType) {
    const match = contentType.match(/boundary="?([^";]+)"?/i);
    return match?.[1];
  }

  async processPart(part) {
    try {
      const raw = jsonFromMimePart(part);
      if (!raw) return;

      const summarized = eventSummary(raw);
      const serialNo = summarized.serialNo;
      if (serialNo && this.seenSerials.has(serialNo)) {
        await log('debug', 'Evento tecnico duplicado ignorado por serialNo', { serialNo });
        return;
      }
      if (serialNo) {
        this.seenSerials.add(serialNo);
        if (this.seenSerials.size > 2000) {
          this.seenSerials = new Set([...this.seenSerials].slice(-1000));
        }
      }

      const now = Date.now();
      const previous = summarized.employeeNo
        ? this.lastEmployeeEvent.get(summarized.employeeNo)
        : null;
      const operationalDuplicate =
        previous &&
        now - previous.ts <
          (this.hikvisionClient.settings.dedupWindowMs || config.hikvision.dedupWindowMs);

      if (summarized.employeeNo) {
        this.lastEmployeeEvent.set(summarized.employeeNo, {
          ts: now,
          serialNo
        });
      }

      const record = await addEvent({
        ...summarized,
        faceDeviceId: this.hikvisionClient.settings.id,
        faceDeviceType: 'hikvision',
        deviceName: summarized.deviceName || this.hikvisionClient.settings.bridgeIdentifier,
        device: summarized.device || this.hikvisionClient.settings.host,
        operationalDuplicate: Boolean(operationalDuplicate)
      });

      if (!operationalDuplicate) {
        if (this.onAccessEvent) {
          Promise.resolve(this.onAccessEvent(record)).catch((error) => {
            log('error', 'No se pudo procesar evento facial como movimiento', {
              error: error.message,
              faceDeviceId: record.faceDeviceId,
              employeeNo: record.employeeNo,
              serialNo: record.serialNo
            }).catch(() => {});
          });
        }
        this.eoloClient.sendEvent(record).catch((error) => {
          log('error', 'No se pudo enviar evento a EOLO', { error: error.message }).catch(() => {});
        });
      }
    } catch (error) {
      await log('warn', 'No se pudo interpretar una parte del stream', {
        error: error.message
      });
    }
  }
}
