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
  constructor(hikvisionClient, eoloClient) {
    this.hikvisionClient = hikvisionClient;
    this.eoloClient = eoloClient;
    this.abortController = null;
    this.running = false;
    this.seenSerials = new Set();
    this.lastEmployeeEvent = new Map();
  }

  async start() {
    if (this.running) return { running: true, alreadyRunning: true };

    this.abortController = new AbortController();
    this.running = true;
    await log('info', 'Iniciando stream de eventos Hikvision');
    this.consume(this.abortController.signal).catch(async (error) => {
      if (error.name !== 'AbortError') {
        await log('error', 'Stream de eventos detenido por error', {
          error: error.message,
          body: error.body
        });
      }
      this.running = false;
    });
    return { running: true };
  }

  stop() {
    if (this.abortController) this.abortController.abort();
    this.abortController = null;
    this.running = false;
    log('info', 'Stream de eventos detenido').catch(() => {});
    return { running: false };
  }

  status() {
    return { running: this.running };
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
        previous && now - previous.ts < config.hikvision.dedupWindowMs;

      if (summarized.employeeNo) {
        this.lastEmployeeEvent.set(summarized.employeeNo, {
          ts: now,
          serialNo
        });
      }

      const record = await addEvent({
        ...summarized,
        operationalDuplicate: Boolean(operationalDuplicate)
      });

      if (!operationalDuplicate) {
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
