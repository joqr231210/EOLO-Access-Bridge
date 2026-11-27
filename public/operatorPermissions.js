function searchKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function permissionStatus(permission, now = Date.now()) {
  const end = Date.parse(permission?.valid_until || '');
  if (permission?.active === false || !Number.isFinite(end) || end <= now) return 'inactive';
  const start = Date.parse(permission?.valid_from || '');
  return Number.isFinite(start) && start > now ? 'upcoming' : 'valid';
}

export function permissionRegistrationIssue(permission, accessId, controlPointId, now = Date.now()) {
  if (!permission || permission.access_id !== accessId) return 'El permiso pertenece a otro acceso.';
  if (!controlPointId) return 'Selecciona un punto de control.';
  if (permissionStatus(permission, now) !== 'valid') return 'El permiso no esta vigente.';
  const points = permission.authorized_control_point_ids || [];
  if (points.length && !points.includes(controlPointId)) return 'Este punto de control no esta autorizado.';
  if (!String(permission.principal_name || permission.user_name || '').trim()) return 'El permiso no tiene nombre.';
  if (permission.is_vehicle && !String(permission.plate || '').trim()) return 'El permiso vehicular no tiene placa.';
  return '';
}

export function filteredPermissions(permissions = [], filters = {}, now = Date.now()) {
  const search = searchKey(filters.search);
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00`) : NaN;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999`) : NaN;
  return permissions.filter((permission) => {
    if (filters.entity === 'vehicle' && !permission.is_vehicle) return false;
    if (filters.entity === 'pedestrian' && permission.is_vehicle) return false;
    const type = searchKey(permission.permission_type);
    if (filters.type === 'otro' && (type.includes('visit') || type.includes('resident'))) return false;
    if (filters.type && filters.type !== 'otro' && !type.includes(searchKey(filters.type))) return false;
    if (filters.status && permissionStatus(permission, now) !== filters.status) return false;
    const start = Date.parse(permission.valid_from || '');
    const end = Date.parse(permission.valid_until || '');
    if (Number.isFinite(from) && (!Number.isFinite(end) || end < from)) return false;
    if (Number.isFinite(to) && Number.isFinite(start) && start > to) return false;
    if (search && !searchKey([
      permission.principal_name, permission.id2, permission.local_id,
      permission.plate, permission.qr_code, permission.card_number,
      permission.permission_type, permission.entity_type
    ].join(' ')).includes(search)) return false;
    return true;
  }).sort((a, b) => {
    const order = { valid: 0, upcoming: 1, inactive: 2 };
    const statusDiff = order[permissionStatus(a, now)] - order[permissionStatus(b, now)];
    if (statusDiff) return statusDiff;
    return (Date.parse(a.valid_until || '') || 0) - (Date.parse(b.valid_until || '') || 0);
  });
}

export function permissionMovementPrefill(permission) {
  return {
    kind: permission.is_vehicle ? 'Vehiculo' : 'Peaton',
    movementType: /resident/i.test(permission.permission_type || '') ? 'Residente' : 'Visita',
    placa: permission.plate || '',
    visitor_name: permission.principal_name || permission.user_name || '',
    permiso_acceso_id: permission.id || '',
    permiso_acceso_id2: permission.id2 || '',
    permission_user_id: permission.user_id || permission.associated_user_id || '',
    face_image_url: permission.face_image || '',
    qr_code: permission.qr_code || '',
    card_number: permission.card_number || '',
    vehicle_id: permission.vehicle_id || '',
    resident_id: permission.resident_id || ''
  };
}
