import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, discoverProject, walkSources } from '../../core/discover.mjs';
import { readText, decodeBuffer, writeIfChanged, sha256File } from '../../core/fsutil.mjs';

function tempDir(t, prefix = 'lvglui-detect-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'components', 'app_ui', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(demo)\n');
  fs.writeFileSync(path.join(root, 'sdkconfig'), 'CONFIG_LV_COLOR_DEPTH=16\n');
  fs.writeFileSync(path.join(root, 'components', 'app_ui', 'src', 'home.c'),
    '#include "lvgl.h"\nvoid home_create(void) { lv_screen_load(home_create()); }\n');
  return root;
}

test('finds project root from nested dir', (t) => {
  const root = fixture(t);
  const hit = findProjectRoot(path.join(root, 'components', 'app_ui'));
  assert.equal(hit.root, path.resolve(root));
  assert.equal(hit.how, 'cmake');
});

test('detects uiDir, entry from call site, and sources', (t) => {
  const root = fixture(t);
  const p = discoverProject(root, { toolRoot: 'D:/LVGL_preview' });
  assert.equal(p.ok, true);
  assert.equal(p.uiDir, path.resolve(root, 'components/app_ui'));
  assert.equal(p.entry, 'home_create');
  assert.equal(p.entryHow, 'call-site');
  assert.equal(p.sources.length, 1);
});

test('walkSources ignores build and hidden dirs', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'components', 'app_ui', 'build'));
  fs.writeFileSync(path.join(root, 'components', 'app_ui', 'build', 'x.c'), '');
  fs.mkdirSync(path.join(root, 'components', 'app_ui', '.cache'));
  fs.writeFileSync(path.join(root, 'components', 'app_ui', '.cache', 'y.c'), '');
  const list = walkSources(path.join(root, 'components/app_ui'));
  assert.equal(list.length, 1);
  assert.match(list[0], /src[\\/]home\.c$/);
});

test('reports a config marker as root', (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, 'lvglui.json'), '{"schema":1}\n');
  const hit = findProjectRoot(root);
  assert.equal(hit.root, path.resolve(root));
  assert.equal(hit.how, 'config');
});

test('a project() CMakeLists without sdkconfig or main is not a root', (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(demo)\n');
  fs.mkdirSync(path.join(root, 'nested'));
  assert.equal(findProjectRoot(path.join(root, 'nested')), null);
});

test('skipDir and its descendants are never project roots', (t) => {
  const outer = tempDir(t);
  fs.writeFileSync(path.join(outer, 'CMakeLists.txt'), 'project(demo)\n');
  fs.writeFileSync(path.join(outer, 'sdkconfig'), '');
  const tool = path.join(outer, 'tool');
  fs.mkdirSync(tool);
  fs.writeFileSync(path.join(tool, 'lvglui.json'), '{"schema":1}\n');
  const hit = findProjectRoot(tool, { skipDir: tool });
  assert.equal(hit.root, path.resolve(outer));
  assert.equal(hit.how, 'cmake');
});

test('config beats directory conventions for uiDir and entry', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'components', 'ui'));
  fs.writeFileSync(path.join(root, 'components', 'ui', 'custom.c'),
    'lv_obj_t *custom_entry(lv_obj_t *parent) { return parent; }\n');
  fs.writeFileSync(path.join(root, 'lvglui.json'), JSON.stringify({
    schema: 1,
    uiDir: 'components/ui',
    entry: 'custom_entry',
  }));
  const p = discoverProject(root);
  assert.equal(p.ok, true);
  assert.equal(p.rootHow, 'config');
  assert.equal(p.uiDir, path.resolve(root, 'components/ui'));
  assert.equal(p.uiDirHow, 'config');
  assert.equal(p.entry, 'custom_entry');
  assert.equal(p.entryHow, 'config');
  assert.equal(p.sources.length, 1);
});

test('requireUi false tolerates a project without UI', (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(demo)\n');
  fs.writeFileSync(path.join(root, 'sdkconfig'), '');
  const p = discoverProject(root, { requireUi: false });
  assert.equal(p.ok, true);
  assert.equal(p.uiDir, null);
  assert.equal(p.entry, null);
  assert.deepEqual(p.sources, []);
  assert.deepEqual(p.problems, []);
});

test('walkSources returns absolute, sorted paths and honours depth', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'b', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b.c'), '');
  fs.writeFileSync(path.join(root, 'a.c'), '');
  fs.writeFileSync(path.join(root, 'b', 'c.c'), '');
  fs.writeFileSync(path.join(root, 'b', 'deep', 'd.c'), '');
  fs.writeFileSync(path.join(root, 'ignored.h'), '');
  const list = walkSources(root);
  assert.deepEqual(list, [...list].sort());
  assert.equal(list.length, 4);
  assert.ok(list.every((file) => path.isAbsolute(file)));
  assert.equal(walkSources(root, { maxDepth: 0 }).length, 2);
  assert.equal(walkSources(root, { exts: ['.h'] }).length, 1);
});

test('readText returns null for a missing file', (t) => {
  const root = tempDir(t);
  assert.equal(readText(path.join(root, 'missing.c')), null);
});

test('decodeBuffer falls back to GBK when UTF-8 is invalid', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBuffer(gbk), '中文');
  assert.equal(decodeBuffer(Buffer.from('中文', 'utf8')), '中文');
});

test('writeIfChanged creates parents and only rewrites changed content', (t) => {
  const root = tempDir(t);
  const file = path.join(root, 'nested', 'dir', 'file.txt');
  assert.deepEqual(writeIfChanged(file, 'one\n'), { changed: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
  assert.deepEqual(writeIfChanged(file, 'one\n'), { changed: false });
  assert.deepEqual(writeIfChanged(file, 'two\n'), { changed: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
});

test('sha256File hashes the file bytes', (t) => {
  const root = tempDir(t);
  const file = path.join(root, 'x.bin');
  fs.writeFileSync(file, 'abc');
  assert.equal(sha256File(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});