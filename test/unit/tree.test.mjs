import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTree, collectNames } from '../../core/tree.mjs';

test('compacts deep tree and truncates text', () => {
  let node = { name: 'leaf', cls: 'lv_label', text: 'x'.repeat(100), children: [] };
  for (let i = 0; i < 30; i++) node = { name: `n${i}`, cls: 'lv_obj', children: [node] };
  const c = compactTree({ root: node }, { maxNodes: 5, maxText: 8 });
  assert.equal(c.truncated, true);
  assert.ok(JSON.stringify(c).length < JSON.stringify(node).length);
});

test('collects names recursively', () => {
  const t = { root: { name: 'a', children: [{ name: 'b', children: [] }] } };
  assert.deepEqual(collectNames(t).sort(), ['a', 'b']);
});