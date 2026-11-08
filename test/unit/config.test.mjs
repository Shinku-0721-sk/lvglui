import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, writeConfig, normalizeConfig, projectPaths } from '../../core/config.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

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

test('invalid paths normalize back to safe defaults', () => {
  const r = normalizeConfig({ uiDir: '../outside', build: { dir: 'D:/outside' } }, 'D:/proj');
  assert.equal(r.ok, false);
  assert.equal(r.config.uiDir, '');
  assert.equal(r.config.build.dir, '.lvglui/build');
});

test('projectPaths rejects build.dir escaping project', () => {
  assert.throws(
    () => projectPaths('D:/proj', { build: { dir: '../outside' } }),
    /inside project/,
  );
  assert.throws(
    () => projectPaths('D:/proj', { build: { dir: 'D:/outside' } }),
    /inside project/,
  );
});

test('readConfig reports a missing config as non-error', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(readConfig(root), { file: null, data: null, error: null });
});

test('readConfig strips a UTF-8 BOM', (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'lvglui.json'), '\uFEFF{"schema":1}\n');
  const r = readConfig(root);
  assert.equal(r.error, null);
  assert.equal(r.data.schema, 1);
});

test('readConfig error names the resolved config file', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'lvglui.json');
  fs.writeFileSync(file, '{ not json');
  const r = readConfig(root);
  assert.equal(r.data, null);
  assert.ok(r.error);
  assert.ok(r.error.includes(file), `error should include ${file}: ${r.error}`);
});

test('writeConfig round-trips and ends with a newline', (t) => {
  const root = tempRoot(t);
  const config = normalizeConfig({ uiDir: 'components/app_ui' }, root).config;
  const { file } = writeConfig(root, config);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  const r = readConfig(root);
  assert.equal(r.error, null);
  assert.deepEqual(r.data, config);
});

test('null uiDir/build/font are problems but display:null is a default', () => {
  const r = normalizeConfig({ uiDir: null, build: null, font: null }, 'D:/proj');
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join(' '), /uiDir must be a string/);
  assert.match(r.problems.join(' '), /build must be an object/);
  assert.match(r.problems.join(' '), /font must be an object/);
  assert.equal(r.config.uiDir, '');
  assert.equal(r.config.build.dir, '.lvglui/build');
  assert.equal(r.config.font.cjk, true);
  assert.equal(normalizeConfig({ display: null }, 'D:/proj').ok, true);
});
