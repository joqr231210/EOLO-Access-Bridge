export const DEFAULT_USER_SYNC_WORKFLOW = 'permisos-acceso';

export function normalizeWorkflowEndpoint(rawValue, fallback = DEFAULT_USER_SYNC_WORKFLOW) {
  const raw = String(rawValue || '').trim() || fallback;
  let value = raw;

  try {
    const url = new URL(raw, 'https://eolo.app');
    value = url.pathname;
  } catch (_error) {
    value = raw;
  }

  value = value
    .replace(/^\/+/, '')
    .replace(/^version-[^/]+\/api\/1\.1\/wf\//, '')
    .replace(/^api\/1\.1\/wf\//, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '');

  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new Error('El workflow de sincronizacion EOLO no es valido');
  }

  return value;
}
