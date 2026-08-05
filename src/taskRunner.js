import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

export class TaskRunner {
  constructor(device, eoloClient) {
    this.device = device;
    this.eoloClient = eoloClient;
    this.pollTimer = null;
  }

  async run(task) {
    const action = task.action || task.type;
    const employee = task.employee || task.payload || {};
    const employeeNo = task.employeeNo || employee.employeeNo;

    await log('info', 'Ejecutando tarea', { taskId: task.id, action, employeeNo });

    let result;
    if (action === 'createEmployee' || action === 'create' || action === 'upsertEmployee') {
      result = await this.device.createEmployee(employee);
    } else if (action === 'updateEmployee' || action === 'update') {
      result = await this.device.updateEmployee(employeeNo, employee);
    } else if (action === 'deleteEmployee' || action === 'delete') {
      result = await this.device.deleteEmployee(employeeNo);
    } else if (action === 'uploadFace' || action === 'face') {
      result = await this.uploadFaceFromTask(employeeNo, task);
    } else {
      throw new Error(`Accion de tarea no soportada: ${action}`);
    }

    const taskResult = { ok: true, taskId: task.id, action, employeeNo, result };
    this.eoloClient.ackTask(task.id, taskResult).catch((error) => {
      log('warn', 'No se pudo confirmar tarea a EOLO', {
        taskId: task.id,
        error: error.message
      }).catch(() => {});
    });
    return taskResult;
  }

  async uploadFaceFromTask(employeeNo, task) {
    if (!task.faceImageBase64) {
      throw new Error('La tarea de rostro requiere faceImageBase64');
    }

    const ext = task.faceMimeType === 'image/png' ? 'png' : 'jpg';
    const filePath = path.join(config.uploadDir, `${employeeNo}-${Date.now()}.${ext}`);
    await fs.promises.writeFile(filePath, Buffer.from(task.faceImageBase64, 'base64'));
    return this.device.uploadFace(employeeNo, filePath, {
      originalName: `${employeeNo}.${ext}`,
      mimeType: task.faceMimeType || 'image/jpeg'
    });
  }

  startPolling() {
    if (this.pollTimer || !config.eolo.pollEnabled) return;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((error) => {
        log('error', 'Fallo el polling de tareas EOLO', { error: error.message }).catch(() => {});
      });
    }, config.eolo.pollIntervalMs);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async pollOnce() {
    const tasks = await this.eoloClient.fetchTasks();
    for (const task of tasks) {
      await this.run(task);
    }
    if (tasks.length) await log('info', 'Tareas EOLO procesadas', { count: tasks.length });
    return tasks.length;
  }
}
