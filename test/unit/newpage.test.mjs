import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../../core/init.mjs';
import { newPage, pageHeader, pageSource } from '../../core/newpage.mjs';

// Build a real template project with `init` so the table under test is the one
// projects actually get, not a hand-written approximation.
function makeProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-new-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const ctx = {
    root,
    config: {},
    uiDir: 'components/app_ui',
    idf: { path: path.join(root, 'esp-idf') },
    lvgl: { dir: path.join(root, 'managed_components', 'lvgl__lvgl') },
    display: { width: 240, height: 320, colorDepth: 16 },
  };
  const result = initProject(ctx);
  assert.equal(result.ok, true, result.problems.join('; '));
  const uiDir = path.join(root, 'components', 'app_ui');
  return {
    base,
    root,
    uiDir,
    table: path.join(uiDir, 'src', 'ui_pages.c'),
    header: path.join(uiDir, 'include', 'pages', 'settings.h'),
    source: path.join(uiDir, 'src', 'pages', 'settings.c'),
  };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('newPage adds the page files and registers the page last', () => {
  const project = makeProject();
  try {
    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });

    assert.equal(result.ok, true, result.problems?.join('; '));
    assert.equal(result.page, 'settings');
    assert.deepEqual(result.pages, { before: 1, after: 2, names: ['home', 'settings'] });
    assert.deepEqual([...result.created].sort(), [
      'components/app_ui/include/pages/settings.h',
      'components/app_ui/src/pages/settings.c',
    ]);
    assert.deepEqual(result.updated, [
      'components/app_ui/src/ui_pages.c',
      'components/app_ui/CMakeLists.txt',
    ]);
    assert.equal(result.cmake.mode, 'srcs');
    assert.equal(result.cmake.changed, true);
    assert.ok(result.backups.length >= 1);
    for (const backup of result.backups) {
      assert.ok(backup.startsWith('.lvglui/backup/'));
      assert.ok(fs.existsSync(path.join(project.root, backup)));
    }
    assert.deepEqual(result.warnings, []);

    assert.equal(read(project.header), pageHeader('settings'));
    assert.equal(read(project.source), pageSource('settings'));

    const cmake = read(path.join(project.uiDir, 'CMakeLists.txt'));
    assert.match(cmake, /"src\/pages\/settings\.c"/);
    assert.ok(cmake.indexOf('"src/pages/settings.c"') > cmake.indexOf('"src/pages/home.c"'));
    assert.ok(cmake.indexOf('"src/pages/settings.c"') < cmake.indexOf('INCLUDE_DIRS'));

    const table = read(project.table);
    assert.match(table, /#include "pages\/settings\.h"/);
    assert.match(table, /\{ "settings", ui_page_settings_create \},/);
    assert.ok(table.indexOf('pages/settings.h') > table.indexOf('pages/home.h'),
      'include should follow the last pages include');
    assert.ok(table.indexOf('ui_page_settings_create') > table.indexOf('ui_page_home_create'),
      'new page should be the last entry');
    assert.ok(table.indexOf('{ "home", ui_page_home_create },') !== -1,
      'existing entries keep their commas');
  } finally {
    cleanup(project.base);
  }
});

test('newPage refuses a duplicate page without touching the table', () => {
  const project = makeProject();
  try {
    assert.equal(newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' }).ok, true);
    const before = read(project.table);

    const second = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'usage');
    assert.ok(second.problems.some((p) => p.includes('页面表里已有')));
    assert.equal(read(project.table), before);
  } finally {
    cleanup(project.base);
  }
});

test('newPage --dry-run reports the plan and writes nothing', () => {
  const project = makeProject();
  try {
    const before = read(project.table);
    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings', dryRun: true });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.backups, []);
    assert.equal(result.pages.after, 2);
    assert.ok(!fs.existsSync(project.header));
    assert.ok(!fs.existsSync(project.source));
    assert.equal(read(project.table), before);
    assert.ok(!fs.existsSync(path.join(project.root, '.lvglui', 'backup')));
  } finally {
    cleanup(project.base);
  }
});

test('newPage rejects bad names before touching the filesystem', () => {
  const project = makeProject();
  try {
    const before = read(project.table);
    for (const name of ['', 'Settings', 'settings-page', '1settings', 'for', 'a'.repeat(49)]) {
      const result = newPage({ root: project.root, uiDir: project.uiDir }, { name });
      assert.equal(result.ok, false, `accepted ${JSON.stringify(name)}`);
      assert.equal(result.stage, 'usage');
    }
    assert.equal(read(project.table), before);
    assert.ok(!fs.existsSync(project.header));
    assert.ok(!fs.existsSync(project.source));
  } finally {
    cleanup(project.base);
  }
});

test('newPage refuses projects without the multi-page table', () => {
  const project = makeProject();
  try {
    fs.rmSync(project.table);
    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'usage');
    assert.ok(result.problems.some((p) => p.includes('没有多页契约')));
  } finally {
    cleanup(project.base);
  }
});

test('newPage rejects an entry split over several lines instead of guessing', () => {
  const project = makeProject();
  try {
    const text = read(project.table).replace(
      '{ "home", ui_page_home_create },',
      '{ "home",\n        ui_page_home_create },',
    );
    fs.writeFileSync(project.table, text);

    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'usage');
    assert.ok(result.problems.some((p) => p.includes('不是单行条目')));
    assert.equal(read(project.table), text);
    assert.ok(!fs.existsSync(project.header));
    assert.ok(!fs.existsSync(project.source));
  } finally {
    cleanup(project.base);
  }
});

test('newPage repairs a missing comma on the last entry', () => {
  const project = makeProject();
  try {
    const text = read(project.table).replace(
      '{ "home", ui_page_home_create },',
      '{ "home", ui_page_home_create }',
    );
    fs.writeFileSync(project.table, text);

    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, true, result.problems?.join('; '));
    const table = read(project.table);
    assert.match(table, /\{ "home", ui_page_home_create \},\r?\n/);
    assert.match(table, /\{ "settings", ui_page_settings_create \},/);
    assert.doesNotMatch(table, /,,\s*\{ "settings"/);
  } finally {
    cleanup(project.base);
  }
});

test('newPage keeps CRLF line endings', () => {
  const project = makeProject();
  try {
    const text = read(project.table).replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(project.table, text);

    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, true, result.problems?.join('; '));
    const table = read(project.table);
    assert.ok(table.includes('\r\n'));
    assert.ok(!/[^\r]\n/.test(table), 'mixed line endings after insert');
  } finally {
    cleanup(project.base);
  }
});

test('newPage inserts the page into an explicit SRCS list', () => {
  const project = makeProject();
  try {
    const cmakeFile = path.join(project.uiDir, 'CMakeLists.txt');
    fs.writeFileSync(cmakeFile, [
      'idf_component_register(',
      '  SRCS "src/ui.c" "src/ui_pages.c" "src/pages/home.c"',
      '  INCLUDE_DIRS "include"',
      ')',
      '',
    ].join('\n'));

    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'usage');
    assert.ok(result.problems.some((p) => p.includes('每行一个')));
    assert.ok(!fs.existsSync(project.header));
  } finally {
    cleanup(project.base);
  }
});

test('newPage leaves SRC_DIRS components alone and warns when pages are not covered', () => {
  const project = makeProject();
  try {
    const cmakeFile = path.join(project.uiDir, 'CMakeLists.txt');
    fs.writeFileSync(cmakeFile, [
      'idf_component_register(',
      '  SRC_DIRS "src" "src/pages"',
      '  INCLUDE_DIRS "include"',
      ')',
      '',
    ].join('\n'));

    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, true, result.problems?.join('; '));
    assert.equal(result.cmake.mode, 'src-dirs');
    assert.equal(result.cmake.changed, false);
    assert.deepEqual(result.updated, ['components/app_ui/src/ui_pages.c']);
    assert.deepEqual(result.warnings, []);
    assert.equal(read(cmakeFile).includes('settings.c'), false);
  } finally {
    cleanup(project.base);
  }
});

test('newPage rolls back both files when the source cannot be written', () => {
  const project = makeProject();
  try {
    const before = read(project.table);
    const cmakeBefore = read(path.join(project.uiDir, 'CMakeLists.txt'));
    // A file where the source directory should be makes the write fail.
    const pagesDir = path.join(project.uiDir, 'src', 'pages');
    fs.renameSync(pagesDir, `${pagesDir}-ok`);
    fs.writeFileSync(pagesDir, 'blocked');

    const result = newPage({ root: project.root, uiDir: project.uiDir }, { name: 'settings' });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'io');
    assert.equal(read(project.table), before);
    assert.equal(read(path.join(project.uiDir, 'CMakeLists.txt')), cmakeBefore);
    assert.ok(!fs.existsSync(project.header), 'header should be rolled back');
  } finally {
    cleanup(project.base);
  }
});

test('newPage rejects a UI directory outside the project', () => {
  const project = makeProject();
  try {
    const result = newPage({ root: project.root, uiDir: path.join(project.root, '..', 'elsewhere') }, { name: 'settings' });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'ctx');
  } finally {
    cleanup(project.base);
  }
});

test('pageSource title-cases the page name', () => {
  assert.match(pageSource('sensor_detail'), /lv_label_set_text\(title, "Sensor Detail"\)/);
  assert.match(pageSource('home'), /lv_label_set_text\(title, "Home"\)/);
});