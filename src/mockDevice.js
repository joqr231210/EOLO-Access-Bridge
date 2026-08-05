import { addEvent, log } from './logger.js';

export class MockDevice {
  constructor() {
    this.employees = new Map();
    this.serialNo = 1000;
    this.interval = null;
  }

  async deviceInfo() {
    return {
      DeviceInfo: {
        deviceName: 'Life Mock',
        model: 'DS-K1T323MBWX-E1',
        firmwareVersion: 'V4.23.2',
        ipAddress: '192.168.1.77'
      }
    };
  }

  async capabilities() {
    return {
      isSupportSubscribeEvent: true,
      isSupportAccessControlCap: true,
      isSupportWebSocket: true,
      isSupportPictureServer: true
    };
  }

  async createEmployee(employee) {
    this.employees.set(String(employee.employeeNo), employee);
    await log('info', 'Empleado creado en mock', { employeeNo: employee.employeeNo });
    return { statusCode: 1, statusString: 'OK', mock: true };
  }

  async searchEmployees({ employeeNo, maxResults = 30, position = 0 } = {}) {
    const employees = [...this.employees.values()].filter((employee) =>
      employeeNo ? String(employee.employeeNo) === String(employeeNo) : true
    );
    const slice = employees.slice(Number(position) || 0, (Number(position) || 0) + Number(maxResults));
    return {
      UserInfoSearch: {
        responseStatusStrg: 'OK',
        numOfMatches: slice.length,
        totalMatches: employees.length,
        UserInfo: slice
      },
      mock: true
    };
  }

  async updateEmployee(employeeNo, employee) {
    this.employees.set(String(employeeNo), { ...employee, employeeNo: String(employeeNo) });
    await log('info', 'Empleado actualizado en mock', { employeeNo });
    return { statusCode: 1, statusString: 'OK', mock: true };
  }

  async deleteEmployee(employeeNo) {
    this.employees.delete(String(employeeNo));
    await log('info', 'Empleado eliminado en mock', { employeeNo });
    return { statusCode: 1, statusString: 'OK', mock: true };
  }

  async uploadFace(employeeNo) {
    await log('info', 'Rostro asociado en mock', { employeeNo });
    return { statusCode: 1, statusString: 'OK', mock: true };
  }

  async emitRecognition(employeeNo = '1001', name = 'Persona de prueba') {
    this.serialNo += 1;
    const event = {
      eventType: 'AccessControllerEvent',
      eventState: 'active',
      dateTime: new Date().toISOString(),
      AccessControllerEvent: {
        deviceName: 'Life Mock',
        majorEventType: 5,
        subEventType: 75,
        name,
        cardReaderNo: 1,
        employeeNoString: String(employeeNo),
        serialNo: this.serialNo,
        userType: 'normal',
        currentVerifyMode: 'cardOrFace',
        currentEvent: true,
        mask: 'no'
      }
    };
    await addEvent({
      eventType: event.eventType,
      eventState: event.eventState,
      dateTime: event.dateTime,
      deviceName: event.AccessControllerEvent.deviceName,
      majorEventType: event.AccessControllerEvent.majorEventType,
      subEventType: event.AccessControllerEvent.subEventType,
      employeeNo: event.AccessControllerEvent.employeeNoString,
      name: event.AccessControllerEvent.name,
      serialNo: event.AccessControllerEvent.serialNo,
      cardReaderNo: event.AccessControllerEvent.cardReaderNo,
      currentVerifyMode: event.AccessControllerEvent.currentVerifyMode,
      userType: event.AccessControllerEvent.userType,
      mask: event.AccessControllerEvent.mask,
      operationalDuplicate: false,
      raw: event
    });
    return event;
  }

  startAutoEvents() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      const first = this.employees.values().next().value;
      this.emitRecognition(first?.employeeNo || '1001', first?.name || 'Persona de prueba');
    }, 15000);
  }

  stopAutoEvents() {
    clearInterval(this.interval);
    this.interval = null;
  }
}
