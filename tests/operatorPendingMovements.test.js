import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const operatorSource = fs.readFileSync(path.resolve('public/operator.js'), 'utf8');

function sourceFunction(name, nextName) {
  const start = operatorSource.indexOf(`function ${name}(`);
  const match = operatorSource.slice(start).match(new RegExp(`\\n(?:async )?function ${nextName}\\(`));
  const end = match ? start + match.index : -1;
  assert.ok(start >= 0 && end > start, `Cannot locate ${name}`);
  return operatorSource.slice(start, end);
}

test('renders separate discard actions for pending movements', () => {
  const panel = { classList: { toggle(name, hidden) { this[name] = hidden; } } };
  const list = { innerHTML: '' };
  const summary = { textContent: '' };
  const nodes = {
    '#pendingSyncPanel': panel,
    '#pendingSyncList': list,
    '#pendingSyncSummary': summary
  };
  const context = {
    $: (selector) => nodes[selector],
    state: {
      pendingMovements: [
        {
          id: 'local-1',
          status: 'requires-action',
          createdAt: '2026-10-01T12:00:00Z',
          lastError: 'Foto faltante',
          movement: { visitor_name: 'Primero', kind: 'Vehiculo' }
        },
        {
          id: 'local-"2',
          status: 'pending',
          createdAt: '2026-10-01T12:01:00Z',
          movement: { visitor_name: 'Segundo', kind: 'Vehiculo' }
        }
      ]
    },
    formatSyncDateTime: (value) => value
  };
  context.escapeHtml = vm.runInNewContext(`(${sourceFunction('escapeHtml', 'displayText')})`);
  const render = vm.runInNewContext(`(${sourceFunction('renderPendingMovements', 'discardPendingMovement')})`, context);

  render();

  assert.equal(panel.classList.hidden, false);
  assert.match(summary.textContent, /2 registros/);
  assert.equal((list.innerHTML.match(/data-discard-pending-movement=/g) || []).length, 2);
  assert.match(list.innerHTML, /data-discard-pending-movement="local-&quot;2"/);
  assert.match(list.innerHTML, /Requiere accion manual/);
});
