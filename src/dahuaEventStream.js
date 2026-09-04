import { config } from './config.js';
import { addEvent, log } from './logger.js';

export class DahuaEventStream {
  constructor(dahuaClient, eoloClient, options = {}) {
    this.dahuaClient = dahuaClient;
    this.eoloClient = eoloClient;
    this.onAccessEvent = options.onAccessEvent || null;
    this.abortController = null;
    this.running = false;
    this.desired = false;
    this.retryTimer = null;
    this.lastEventByKey = new Map();
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
    await log('info', 'Iniciando stream de eventos Dahua ASI', {
      deviceId: this.dahuaClient.settings.id,
      deviceName: this.dahuaClient.settings.bridgeIdentifier,
      host: this.dahuaClient.settings.host
    });
    const signal = this.abortController.signal;
    this.consume(signal).then(async () => {
      if (signal.aborted) return;
      await log('warn', 'Stream Dahua finalizo sin error; se reintentara', {
        deviceId: this.dahuaClient.settings.id
      });
      this.running = false;
      this.abortController = null;
      if (this.desired) this.scheduleReconnect();
    }).catch(async (error) => {
      const shouldReconnect = this.desired && error.name !== 'AbortError';
      if (error.name !== 'AbortError') {
        await log('error', 'Stream Dahua detenido por error', {
          error: error.message,
          body: error.body
        });
      }
      this.running = false;
      this.abortController = null;
      if (shouldReconnect) this.scheduleReconnect();
    });
    return { running: true, device: 'dahua' };
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
    log('info', 'Stream de eventos Dahua detenido', {
      deviceId: this.dahuaClient.settings.id,
      deviceName: this.dahuaClient.settings.bridgeIdentifier
    }).catch(() => {});
    return { running: false, device: 'dahua', deviceId: this.dahuaClient.settings.id };
  }

  status() {
    return {
      running: this.running,
      retrying: Boolean(this.retryTimer),
      device: 'dahua',
      deviceId: this.dahuaClient.settings.id
    };
  }

  scheduleReconnect() {
    if (!this.desired || this.retryTimer) return;
    const delayMs = Math.max(3000, Number(this.dahuaClient.settings.reconnectDelayMs || 10000));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.desired || this.running) return;
      this.start().catch((error) => {
        log('error', 'No se pudo reintentar stream Dahua', {
          error: error.message,
          deviceId: this.dahuaClient.settings.id
        }).catch(() => {});
      });
    }, delayMs);
    this.retryTimer.unref?.();
  }

  async consume(signal) {
    const codes = String(this.dahuaClient.settings.eventCodes || 'All')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean)
      .join(',');
    const heartbeat = Number(this.dahuaClient.settings.heartbeatSeconds || 5);
    const response = await this.dahuaClient.stream(
      `/cgi-bin/eventManager.cgi?action=attach&codes=[${encodeURIComponent(codes)}]&heartbeat=${heartbeat}`,
      { signal }
    );
    let buffer = '';

    for await (const chunk of response.body) {
      if (signal.aborted) break;
      buffer += Buffer.from(chunk).toString('utf8');
      const packets = splitDahuaPackets(buffer);
      buffer = packets.remainder;
      for (const packet of packets.items) {
        await this.processPacket(packet);
      }
      if (buffer.length > 1024 * 1024) {
        buffer = buffer.slice(-1024 * 128);
        await log('warn', 'Buffer Dahua recortado por exceso de tamano');
      }
    }
  }

  async processPacket(packet) {
    const event = parseDahuaEvent(packet);
    if (!event) return;
    const normalized = normalizeDahuaEvent(event, this.dahuaClient.settings);
    const key = [
      normalized.eventType,
      normalized.employeeNo,
      normalized.cardNo,
      normalized.currentVerifyMode,
      normalized.eventState
    ].join('|');
    const now = Date.now();
    const previous = this.lastEventByKey.get(key);
    const operationalDuplicate =
      previous && now - previous < (this.dahuaClient.settings.dedupWindowMs || config.dahua.dedupWindowMs);
    this.lastEventByKey.set(key, now);
    if (this.lastEventByKey.size > 2000) {
      this.lastEventByKey = new Map([...this.lastEventByKey].slice(-1000));
    }

    const record = await addEvent({
      ...normalized,
      faceDeviceId: this.dahuaClient.settings.id,
      faceDeviceType: 'dahua',
      operationalDuplicate: Boolean(operationalDuplicate)
    });
    if (!operationalDuplicate) {
      if (this.onAccessEvent) {
        Promise.resolve(this.onAccessEvent(record)).catch((error) => {
          log('error', 'No se pudo procesar evento Dahua como movimiento', {
            error: error.message,
            faceDeviceId: record.faceDeviceId,
            employeeNo: record.employeeNo,
            cardNo: record.cardNo,
            serialNo: record.serialNo
          }).catch(() => {});
        });
      }
      this.eoloClient.sendEvent(record).catch((error) => {
        log('error', 'No se pudo enviar evento Dahua a EOLO', { error: error.message }).catch(() => {});
      });
    }
  }
}

function splitDahuaPackets(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const chunks = normalized.split(/--[A-Za-z0-9_-]+(?:--)?\n/g);
  if (chunks.length > 1) {
    return {
      items: chunks.slice(0, -1).filter((chunk) => chunk.includes('Code=') || chunk.includes('data=')),
      remainder: chunks[chunks.length - 1] || ''
    };
  }

  const lines = normalized.split('\n');
  const items = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === 'Heartbeat') {
      if (current.length) items.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
    if (line.includes('data={') || line.startsWith('index=')) {
      items.push(current.join('\n'));
      current = [];
    }
  }
  return {
    items: items.filter((item) => item.includes('Code=') || item.includes('data=')),
    remainder: current.join('\n')
  };
}

function parseDahuaEvent(packet) {
  const body = packet.includes('\n\n') ? packet.slice(packet.indexOf('\n\n') + 2) : packet;
  if (!body.trim() || body.includes('Heartbeat')) return null;
  const code = matchValue(body, 'Code');
  const action = matchValue(body, 'action') || matchValue(body, 'Action');
  const index = matchValue(body, 'index') || matchValue(body, 'Index');
  const dataText = matchData(body);
  let data = {};
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch {
      data = { rawData: dataText };
    }
  }
  if (!code && !Object.keys(data).length) return null;
  return { code: code || data.Code || 'DahuaEvent', action: action || data.Action || 'Pulse', index, data, raw: body };
}

function normalizeDahuaEvent(event, settings) {
  const data = event.data || {};
  const userId = firstText(
    data.UserID,
    data.userId,
    data.CardUserID,
    data.CardNo,
    data.cardNo,
    data.FingerPrintID,
    data.PersonID
  );
  const name = firstText(data.UserName, data.CardName, data.Name, data.PersonName);
  const verifyMode = inferVerifyMode(event, data);
  return {
    eventType: event.code,
    eventState: event.action || 'Pulse',
    dateTime: dahuaEventTime(data),
    deviceName: settings.bridgeIdentifier || 'Dahua ASI',
    device: settings.host,
    majorEventType: event.code,
    subEventType: firstText(data.Method, data.OpenMethod, data.Status, data.ErrorCode),
    employeeNo: userId,
    name,
    cardNo: firstText(data.CardNo, data.cardNo),
    serialNo: firstText(data.SerialNo, data.Sequence, data.UTC, `${event.code}-${Date.now()}`),
    doorNo: firstText(data.Door, data.DoorNo, data.Channel, event.index, settings.doorNo),
    cardReaderNo: firstText(data.ReaderID, data.ReaderNo),
    currentVerifyMode: verifyMode,
    userType: firstText(data.UserType, data.CardType),
    raw: event.raw
  };
}

function inferVerifyMode(event, data) {
  const text = [event.code, data.Method, data.OpenMethod, data.Type, data.ReaderType]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  if (text.includes('finger') || text.includes('huella')) return 'fingerprint';
  if (text.includes('face') || text.includes('rostro')) return 'face';
  if (text.includes('card') || data.CardNo) return 'card';
  return 'access';
}

function dahuaEventTime(data) {
  if (data.UTC) return new Date(Number(data.UTC) * 1000).toISOString();
  if (data.Time) return String(data.Time).replace(' ', 'T');
  return new Date().toISOString();
}

function matchValue(text, key) {
  const match = text.match(new RegExp(`(?:^|[;\\n])${key}=([^;\\n]+)`, 'i'));
  return match?.[1]?.trim() || '';
}

function matchData(text) {
  const index = text.indexOf('data=');
  if (index === -1) return '';
  const start = text.indexOf('{', index);
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}
