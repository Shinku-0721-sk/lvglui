import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTree, collectNames, clipWarnings } from '../../core/tree.mjs';

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
test('keeps absolute coordinates from the host dump', () => {
  const t = { root: { cls: 'lv_obj', x: 4, y: 5, absX: 34, absY: 45, children: [] } };
  const c = compactTree(t);
  assert.equal(c.root.absX, 34);
  assert.equal(c.root.absY, 45);
});

test('clipWarnings reports content wider than its box', () => {
  const t = { root: { cls: 'lv_obj', w: 200, h: 100, children: [
    { cls: 'lv_label', name: 'probe', w: 80, h: 20, selfW: 318, selfH: 20, children: [] },
  ] } };
  const warnings = clipWarnings(t);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[clip\] lv_label "probe"/);
  assert.match(warnings[0], /318px wide but the box is 80px/);
});

test('clipWarnings reports a child outside a non-scrollable parent', () => {
  const t = { root: { cls: 'lv_obj', absX: 0, absY: 0, w: 100, h: 100, scrollable: false, overflow: false, children: [
    { cls: 'lv_label', name: 'tail', absX: 0, absY: 150, w: 40, h: 10, children: [] },
  ] } };
  const warnings = clipWarnings(t);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /lies outside its parent/);
});

test('clipWarnings stays quiet inside a scrollable parent', () => {
  const t = { root: { cls: 'lv_obj', absX: 0, absY: 0, w: 100, h: 100, scrollable: true, children: [
    { cls: 'lv_label', name: 'tail', absX: 0, absY: 150, w: 40, h: 10, children: [] },
  ] } };
  assert.deepEqual(clipWarnings(t), []);
});
