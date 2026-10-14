import assert from 'node:assert/strict';
import test from 'node:test';
import { EoloUserSync } from '../src/eoloUserSync.js';

function fakeDevice() {
  const calls = { created: [], updated: [], deleted: [] };
  return {
    calls,
    settings: { doorNo: 0 },
    async searchEmployees() { return { UserInfoSearch: { UserInfo: [], totalMatches: 0 } }; },
    async createEmployee(employee) { calls.created.push(employee); },
    async updateEmployee(id, employee) { calls.updated.push({ id, employee }); },
    async deleteEmployee(id) { calls.deleted.push(id); }
  };
}

test('applies the supplied snapshot without reading a stale file', async () => {
  const device = fakeDevice();
  const sync = new EoloUserSync(device, {});
  sync.readCloudSnapshot = async () => { throw new Error('stale snapshot read'); };

  const result = await sync.applySnapshotToDevice({
    accessId: 'access-1',
    snapshot: {
      access: 'access-1',
      downloadedAt: '2026-09-30T15:12:36.009Z',
      employees: [{ employeeNo: 'AC100PR30092026151236', name: 'Persona de prueba' }]
    }
  });

  assert.deepEqual(result.created, ['AC100PR30092026151236']);
  assert.equal(device.calls.created[0].name, 'Persona de prueba');
});

test('rejects a malformed snapshot before changing the device', async () => {
  const device = fakeDevice();
  const sync = new EoloUserSync(device, {});

  await assert.rejects(sync.applySnapshotToDevice({ snapshot: { employees: null } }), /lista valida/);
  assert.equal(device.calls.created.length, 0);
  assert.equal(device.calls.deleted.length, 0);
});

test('rejects a snapshot from another access before changing the device', async () => {
  const device = fakeDevice();
  const sync = new EoloUserSync(device, {});

  await assert.rejects(sync.applySnapshotToDevice({
    accessId: 'access-2',
    snapshot: {
      access: 'access-1',
      employees: [{ employeeNo: 'AC100PR30092026151236', name: 'Persona de prueba' }]
    }
  }), /no pertenece al acceso activo/);
  assert.equal(device.calls.created.length, 0);
  assert.equal(device.calls.deleted.length, 0);
});

test('reports a partial failure when the device rejects a face', async () => {
  const device = fakeDevice();
  const sync = new EoloUserSync(device, {});
  sync.uploadFaceFromUrl = async () => { throw new Error('Rostro rechazado'); };

  const result = await sync.applySnapshotToDevice({
    accessId: 'access-1',
    snapshot: {
      access: 'access-1',
      downloadedAt: '2026-09-30T15:12:36.009Z',
      employees: [{ employeeNo: 'AC100PR30092026151236', name: 'Persona de prueba', faceUrl: 'https://example.test/face.jpg' }]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.skippedFaces.length, 1);
  assert.equal(result.skippedFaces[0].error, 'Rostro rechazado');
});
