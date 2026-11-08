import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLvgl, readLvglVersion } from '../../core/lvgl.mjs';

function tempDir(t, prefix = 'lvglui-lvgl-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function versionHeaderText(major, minor, patch) {
  return `#define LVGL_VERSION_MAJOR ${major}\n`
    + `#define LVGL_VERSION_MINOR ${minor}\n`
    + `#define LVGL_VERSION_PATCH ${patch}\n`;
}

/**
 * Build an LVGL-like tree.
 * - `flat`: `<dir>/lvgl.h` + `<dir>/lv_version.h` (deprecated top-level layout).
 * - `include`: `<dir>/include/lvgl/lvgl.h`; the version header is written to
 *   `<dir>/include/lvgl/lv_version.h` or `<dir>/src/lv_version.h`.
 * `deprecatedShims` adds the real managed component's top-level shim headers,
 * which contain no version defines and must not be mistaken for the version.
 */
function makeLvglDir(dir, options = {}) {
  const {
    major = 9, minor = 6, patch = 0, layout = 'flat', versionAt = 'include', deprecatedShims = false,
  } = options;
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const text = versionHeaderText(major, minor, patch);
  if (layout === 'flat') {
    write(path.join(dir, 'lvgl.h'), '#include "src/lvgl.h"\n');
    write(path.join(dir, 'lv_version.h'), text);
  } else {
    write(path.join(dir, 'include', 'lvgl', 'lvgl.h'), '#ifndef LVGL_H\n#define LVGL_H\n#endif\n');
    if (versionAt === 'src') write(path.join(dir, 'src', 'lv_version.h'), text);
    else write(path.join(dir, 'include', 'lvgl', 'lv_version.h'), text);
    if (deprecatedShims) {
      write(path.join(dir, 'lvgl.h'), '#include "include/lvgl/lvgl.h"\n');
      write(path.join(dir, 'lv_version.h'),
        '#warning This file is deprecated, include <lvgl/lv_version.h> instead\n'
        + '#include "../include/lvgl/lv_version.h"\n');
    }
  }
  return path.resolve(dir);
}

function managedDir(root) {
  return path.join(root, 'managed_components', 'lvgl__lvgl');
}

test('finds a managed component with the deprecated top-level header layout', (t) => {
  const root = tempDir(t);
  const dir = makeLvglDir(managedDir(root));
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dir, dir);
  assert.deepEqual(r.version, { major: 9, minor: 6, patch: 0 });
  assert.equal(r.source, 'managed');
  assert.equal(r.warning, null);
  assert.equal(r.problem, null);
});

test('rejects LVGL 8.x and names the required major version', (t) => {
  const root = tempDir(t);
  makeLvglDir(managedDir(root), { major: 8, minor: 3, patch: 0 });
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, false);
  assert.match(r.problem, /需要 LVGL 9\.x/);
  assert.match(r.problem, /8\.3\.0/);
});

test('config.lvglDir wins over managed and resolves relative to root', (t) => {
  const root = tempDir(t);
  makeLvglDir(managedDir(root), { major: 9, minor: 6 });
  const configured = makeLvglDir(path.join(root, 'vendor', 'lvgl'), {
    major: 9, minor: 2, patch: 1, layout: 'include',
  });
  const r = findLvgl({ root, config: { lvglDir: 'vendor/lvgl' } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'config');
  assert.equal(r.dir, configured);
  assert.deepEqual(r.version, { major: 9, minor: 2, patch: 1 });
});

test('an invalid config.lvglDir hard-fails instead of falling back to managed', (t) => {
  const root = tempDir(t);
  makeLvglDir(managedDir(root));
  // An explicit config path is a user assertion: a sibling lvgl.h without
  // src/ must fail, not silently pick the valid managed component.
  write(path.join(root, 'vendor', 'broken', 'lvgl.h'), '#include "lvgl/lvgl.h"\n');
  write(path.join(root, 'vendor', 'broken', 'lv_version.h'), versionHeaderText(9, 6, 0));

  const r = findLvgl({ root, config: { lvglDir: 'vendor/broken' } });
  assert.equal(r.ok, false);
  assert.equal(r.dir, null);
  assert.match(r.problem, /config\.lvglDir/);
  assert.match(r.problem, /broken/);
  assert.match(r.problem, /src/);
});

test('search finds a nested LVGL tree with include headers and src version header', (t) => {
  const root = tempDir(t);
  const dir = makeLvglDir(path.join(root, 'third_party', 'lvgl'), {
    major: 9, minor: 4, patch: 2, layout: 'include', versionAt: 'src',
  });
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'search');
  assert.equal(r.dir, dir);
  assert.deepEqual(r.version, { major: 9, minor: 4, patch: 2 });
});

test('a candidate with lvgl.h but no src is warned about and skipped', (t) => {
  const root = tempDir(t);
  const broken = managedDir(root);
  write(path.join(broken, 'lvgl.h'), '#include "lvgl/lvgl.h"\n');
  write(path.join(broken, 'lv_version.h'), versionHeaderText(9, 6, 0));
  const valid = makeLvglDir(path.join(root, 'components', 'lvgl'), { major: 9, minor: 1 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dir, valid);
  assert.equal(r.source, 'search');
  assert.match(r.warning, /src/);
  assert.ok(r.warning.includes(path.resolve(broken)), `warning should name ${broken}: ${r.warning}`);
});

test('parses a version header that only exists under include/lvgl', (t) => {
  const root = tempDir(t);
  const dir = makeLvglDir(managedDir(root), { major: 9, minor: 5, patch: 3, layout: 'include' });
  const info = readLvglVersion(dir);
  assert.equal(info.ok, true);
  assert.deepEqual(info.version, { major: 9, minor: 5, patch: 3 });
  assert.equal(info.header, path.join(dir, 'include', 'lvgl', 'lv_version.h'));

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'managed');
  assert.deepEqual(r.version, { major: 9, minor: 5, patch: 3 });
});

test('real managed layout falls through deprecated top-level headers', (t) => {
  const root = tempDir(t);
  const dir = makeLvglDir(managedDir(root), {
    major: 9, minor: 6, patch: 0, layout: 'include', deprecatedShims: true,
  });
  const info = readLvglVersion(dir);
  assert.equal(info.ok, true);
  assert.equal(info.header, path.join(dir, 'include', 'lvgl', 'lv_version.h'));
  assert.deepEqual(info.version, { major: 9, minor: 6, patch: 0 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dir, dir);
  assert.equal(r.source, 'managed');
});

test('search skips .git, build and node_modules', (t) => {
  const root = tempDir(t);
  makeLvglDir(path.join(root, '.git', 'lvgl'));
  makeLvglDir(path.join(root, 'build', 'lvgl'));
  makeLvglDir(path.join(root, 'node_modules', 'lvgl'));
  const valid = makeLvglDir(path.join(root, 'third_party', 'lvgl'), { minor: 3 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dir, valid);
  assert.equal(r.source, 'search');
});

test('search picks the first valid directory in stable sorted order', (t) => {
  const root = tempDir(t);
  const first = makeLvglDir(path.join(root, 'aaa', 'lvgl'), { minor: 1 });
  makeLvglDir(path.join(root, 'zzz', 'lvgl'), { minor: 2 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.dir, first);
  assert.deepEqual(r.version, { major: 9, minor: 1, patch: 0 });
});

test('search finds a candidate at exactly depth 4', (t) => {
  const root = tempDir(t);
  const dir = makeLvglDir(path.join(root, 'a', 'b', 'c', 'lvgl'), { minor: 7 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'search');
  assert.equal(r.dir, dir);
  assert.deepEqual(r.version, { major: 9, minor: 7, patch: 0 });
});

test('search stops at depth 4', (t) => {
  const root = tempDir(t);
  makeLvglDir(path.join(root, 'a', 'b', 'c', 'd', 'lvgl'), { minor: 1 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, false);
  assert.match(r.problem, /depth 4/);
});

test('no candidate reports every tried source and path', (t) => {
  const root = tempDir(t);
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, false);
  assert.equal(r.dir, null);
  assert.match(r.problem, /managed_components/);
  assert.match(r.problem, /components[\\/]lvgl/);
  assert.match(r.problem, /search/);
  assert.ok(r.problem.includes(path.resolve(root)), 'problem should name the project root');
});

test('rejects a minor outside 0..99', (t) => {
  const root = tempDir(t);
  makeLvglDir(managedDir(root), { major: 9, minor: 100 });
  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, false);
  assert.match(r.problem, /minor 100/);
});

test('readLvglVersion reports a missing directory without throwing', (t) => {
  const root = tempDir(t);
  const info = readLvglVersion(path.join(root, 'missing'));
  assert.equal(info.ok, false);
  assert.equal(info.version, null);
  assert.equal(info.header, null);
  assert.match(info.problem, /not a directory/);
});

test('a rejected 8.x project LVGL is warned about when a vendored 9.x wins', (t) => {
  const root = tempDir(t);
  const rejected = makeLvglDir(managedDir(root), { major: 8, minor: 3 });
  const vendored = makeLvglDir(path.join(root, 'third_party', 'lvgl'), { major: 9, minor: 2 });

  const r = findLvgl({ root, config: {} });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'search');
  assert.equal(r.dir, vendored);
  assert.match(r.warning, /8\.3\.0/);
  assert.ok(r.warning.includes(rejected), `warning should name ${rejected}: ${r.warning}`);
});

test('an unstatable config.lvglDir fails structurally instead of throwing', (t) => {
  const root = tempDir(t);
  makeLvglDir(managedDir(root));

  const r = findLvgl({ root, config: { lvglDir: 'vendor/\u0000bad' } });
  assert.equal(r.ok, false);
  assert.equal(r.dir, null);
  assert.match(r.problem, /config\.lvglDir/);
  assert.match(r.problem, /invalid|null byte/i);
});

test('a non-string config.lvglDir is a structured failure', (t) => {
  for (const value of [42, false, {}, null]) {
    const root = tempDir(t);
    makeLvglDir(managedDir(root));

    const r = findLvgl({ root, config: { lvglDir: value } });
    assert.equal(r.ok, false, `config.lvglDir=${JSON.stringify(value)} should fail`);
    assert.equal(r.dir, null);
    assert.match(r.problem, /config\.lvglDir/);
    assert.ok(r.problem.includes(JSON.stringify(value)),
      `problem should name ${JSON.stringify(value)}: ${r.problem}`);
  }
});

test('a config 8.x failure keeps the discovered version', (t) => {
  const root = tempDir(t);
  makeLvglDir(path.join(root, 'vendor', 'lvgl8'), { major: 8, minor: 4, patch: 1 });

  const r = findLvgl({ root, config: { lvglDir: 'vendor/lvgl8' } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.version, { major: 8, minor: 4, patch: 1 });
  assert.match(r.problem, /需要 LVGL 9\.x/);
  assert.match(r.problem, /8\.4\.1/);
});
