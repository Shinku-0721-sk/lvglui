import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectPages, pageFileStems, sanitizePageName } from '../../core/pages.mjs';

const COMPLETE = `
int ui_page_count(void) { return 2; }
const char *ui_page_name(int index) { return "a"; }
lv_obj_t *ui_page_show(int index, lv_obj_t *parent) { return NULL; }
`;

function writeSource(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-pages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('no sources means no page contract and no problems', () => {
  const result = detectPages([]);
  assert.equal(result.supported, false);
  assert.deepEqual(result.found, []);
  assert.deepEqual(result.missing, ['count', 'name', 'show']);
  assert.deepEqual(result.problems, []);
});

test('all three functions define the contract', (t) => {
  const dir = tempDir(t);
  const source = writeSource(dir, 'ui.c', COMPLETE);
  const result = detectPages([source]);
  assert.equal(result.supported, true);
  assert.deepEqual(result.found, ['count', 'name', 'show']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.problems, []);
});

test('a partial contract reports the missing signature instead of failing at link time', (t) => {
  const dir = tempDir(t);
  const source = writeSource(dir, 'ui.c', `
    int ui_page_count(void) { return 1; }
    const char *ui_page_name(int index) { return "a"; }
  `);
  const result = detectPages([source]);
  assert.equal(result.supported, false);
  assert.deepEqual(result.found, ['count', 'name']);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /incomplete page contract: found count, name/);
  assert.match(result.problems[0], /lv_obj_t \*ui_page_show\(int index, lv_obj_t \*parent\)/);
});

test('declarations without bodies do not satisfy the contract', (t) => {
  const dir = tempDir(t);
  const source = writeSource(dir, 'ui_pages.h', `
    int ui_page_count(void);
    const char *ui_page_name(int index);
    lv_obj_t *ui_page_show(int index, lv_obj_t *parent);
  `);
  const result = detectPages([source]);
  assert.equal(result.supported, false);
  assert.deepEqual(result.problems, []);
});

test('unreadable sources are reported and skipped', (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, 'gone.c');
  const result = detectPages([missing]);
  assert.equal(result.supported, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /cannot read .*gone\.c/);
});

test('page names become file-name-safe stems', () => {
  assert.equal(sanitizePageName('home'), 'home');
  assert.equal(sanitizePageName('Home Page'), 'Home-Page');
  assert.equal(sanitizePageName('  '), 'page');
  assert.equal(sanitizePageName('??', 'fallback'), 'fallback');
  assert.equal(sanitizePageName('..'), 'page');
});

test('duplicate page names get distinct stems without reordering', () => {
  assert.deepEqual(pageFileStems(['home', 'home', 'Home', 'settings']),
    ['home', 'home-2', 'Home-3', 'settings']);
});