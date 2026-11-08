import test from 'node:test';
import assert from 'node:assert/strict';

test('Node >= 22', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
});