import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeConfig, projectPaths } from '../../core/config.mjs';

test('defaults leave uiDir/entry/display empty and fill build', () => {
  const r = normalizeConfig({}, 'D:/proj');
  assert.equal(r.ok, true);
  assert.equal(r.config.uiDir, '');
  assert.equal(r.config.entry, '');
  assert.equal(r.config.display, null);
  assert.equal(r.config.build.dir, '.lvglui/build');
});

test('rejects uiDir escaping project', () => {
  const r = normalizeConfig({ uiDir: '../outside' }, 'D:/proj');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /inside project/);
});

test('rejects absolute uiDir', () => {
  const r = normalizeConfig({ uiDir: 'D:/outside' }, 'D:/proj');
  assert.equal(r.ok, false);
});

test('derives build and out paths', () => {
  const p = projectPaths('D:/proj', normalizeConfig({}, 'D:/proj').config);
  assert.equal(p.buildDir, path.resolve('D:/proj/.lvglui/build'));
  assert.equal(p.outDir, path.resolve('D:/proj/.lvglui/out'));
  assert.equal(p.lvConfPath, path.resolve('D:/proj/.lvglui/build/lv_conf.h'));
});