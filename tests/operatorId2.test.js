import assert from 'node:assert/strict';
import test from 'node:test';
import { operatorId2DeviceCode } from '../src/operatorId2.js';

test('device code uses the same two-character folio hash for a known identifier', () => {
  const identifier = 'eolo-bridge-ce886d95-3037-4d45-a609-519d54149208';
  assert.equal(operatorId2DeviceCode(identifier), '72');
  assert.match(operatorId2DeviceCode('another-bridge'), /^[0-9A-Z]{2}$/);
});
