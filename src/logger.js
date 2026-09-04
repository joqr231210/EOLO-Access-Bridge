import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const maxMemoryRecords = 500;
const memory = {
  logs: [],
  events: []
};

export async function ensureDataDirs() {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  await fs.promises.mkdir(config.uploadDir, { recursive: true });
}

async function appendJsonl(fileName, record) {
  const filePath = path.join(config.dataDir, fileName);
  await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function keepLast(collection, record) {
  collection.push(record);
  if (collection.length > maxMemoryRecords) collection.shift();
}

export async function log(level, message, meta = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    meta
  };
  keepLast(memory.logs, record);
  bus.emit('log', record);
  await appendJsonl('logs.jsonl', record).catch(() => {});
  const line = `[${record.ts}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, meta);
  else console.log(line, meta);
  return record;
}

export async function addEvent(event) {
  const record = {
    receivedAt: new Date().toISOString(),
    ...event
  };
  keepLast(memory.events, record);
  bus.emit('event', record);
  await appendJsonl('events.jsonl', record).catch(() => {});
  return record;
}

export function getLogs(limit = 100) {
  return memory.logs.slice(-limit).reverse();
}

export async function getStoredLogs(limit = 500) {
  const max = Math.min(Math.max(Number(limit) || 100, 1), 2000);
  const filePath = path.join(config.dataDir, 'logs.jsonl');
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .slice(-max)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return getLogs(max);
  }
}

export function getEvents(limit = 100) {
  return memory.events.slice(-limit).reverse();
}
