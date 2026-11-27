import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filteredPermissions,
  permissionMovementPrefill,
  permissionRegistrationIssue,
  permissionStatus
} from '../public/operatorPermissions.js';

const now = Date.parse('2026-11-27T12:00:00Z');
const permission = {
  id: 'permission-1',
  id2: 'ACVV123',
  access_id: 'access-1',
  authorized_control_point_ids: ['point-1'],
  principal_name: 'María López',
  permission_type: 'Visitante',
  entity_type: 'Vehiculo',
  is_vehicle: true,
  plate: 'ABC123',
  qr_code: 'QR-456',
  user_id: 'user-1',
  valid_from: '2026-11-26T00:00:00Z',
  valid_until: '2026-11-28T00:00:00Z',
  active: true
};

test('only a valid permission at the selected access and control point is registerable', () => {
  assert.equal(permissionStatus(permission, now), 'valid');
  assert.equal(permissionRegistrationIssue(permission, 'access-1', 'point-1', now), '');
  assert.match(permissionRegistrationIssue(permission, 'access-2', 'point-1', now), /otro acceso/);
  assert.match(permissionRegistrationIssue(permission, 'access-1', 'point-2', now), /no esta autorizado/);
  assert.equal(permissionStatus({ ...permission, valid_from: '2026-11-29T00:00:00Z' }, now), 'upcoming');
  assert.equal(permissionStatus({ ...permission, valid_until: '2026-11-26T00:00:00Z' }, now), 'inactive');
});

test('filters search, entity, status and overlapping validity dates', () => {
  const future = { ...permission, id: 'permission-2', principal_name: 'Pedro', valid_from: '2026-12-01T00:00:00Z', valid_until: '2026-12-04T00:00:00Z' };
  assert.deepEqual(filteredPermissions([permission, future], { search: 'maria', entity: 'vehicle', status: 'valid' }, now).map((item) => item.id), ['permission-1']);
  assert.deepEqual(filteredPermissions([permission, future], { from: '2026-12-02', to: '2026-12-03' }, now).map((item) => item.id), ['permission-2']);
});

test('prefills movement with permit references and vehicle data', () => {
  assert.deepEqual(permissionMovementPrefill(permission), {
    kind: 'Vehiculo', movementType: 'Visita', placa: 'ABC123', visitor_name: 'María López',
    permiso_acceso_id: 'permission-1', permiso_acceso_id2: 'ACVV123',
    permission_user_id: 'user-1', face_image_url: '', qr_code: 'QR-456',
    card_number: '', vehicle_id: '', resident_id: ''
  });
});
