import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, integrationSnippet } from '../../core/init.mjs';

const PORT_FILES = ['CMakeLists.txt', 'include/ui_port.h', 'ui_port_impl.c'];

const TEMPLATE_FILES = [
  'CMakeLists.txt',
  'include/ui.h',
  'include/ui_theme.h',
  'include/ui_pages.h',
  'include/pages/home.h',
  'src/ui.c',
  'src/ui_pages.c',
  'src/ui_theme.c',
  'src/ui_port_stub.c',
  'src/pages/home.c',
];

// One temporary container per test with a dedicated project directory, so a
// rejected `../x` target resolves to a known sibling we can assert was not
// created instead of a real path outside the temp tree.
function makeRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-init-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  return { base, root };
}

function fixtureCtx(root, overrides = {}) {
  return {
    root,
    config: {},
    uiDir: 'components/app_ui',
    idf: { path: path.join(root, 'esp-idf') },
    lvgl: { dir: path.join(root, 'managed_components', 'lvgl__lvgl') },
    display: { width: 240, height: 320, colorDepth: 16 },
    ...overrides,
  };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

test('initProject creates the template files and config, then refuses a second run', () => {
  const { base, root } = makeRoot();
  try {
    const result = initProject(fixtureCtx(root));

    assert.equal(result.ok, true, result.problems.join('; '));
    const uiDir = path.join(root, 'components', 'app_ui');
    for (const rel of TEMPLATE_FILES) {
      assert.ok(fs.existsSync(path.join(uiDir, rel)), `missing ${rel}`);
    }
    const portDir = path.join(root, 'components', 'ui_port');
    for (const rel of PORT_FILES) {
      assert.ok(fs.existsSync(path.join(portDir, rel)), `missing ui_port/${rel}`);
    }
    const expectedCreated = [
      ...TEMPLATE_FILES.map((rel) => `components/app_ui/${rel}`),
      ...PORT_FILES.map((rel) => `components/ui_port/${rel}`),
    ];
    assert.deepEqual([...result.created].sort(), expectedCreated.sort());
    assert.equal(result.configFile, path.join(root, 'lvglui.json'));

    const config = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    assert.equal(config.schema, 1);
    assert.equal(config.uiDir, 'components/app_ui');
    assert.equal(config.entry, 'ui_start');
    assert.deepEqual(config.display, { width: 240, height: 320, colorDepth: 16 });
    assert.deepEqual(config.build, { dir: '.lvglui/build' });
    assert.deepEqual(config.font, { mode: 'off', dynamic: 'labels', file: '', size: 16, name: '', cjk: false, fsPath: '', freetypeDir: '' });
    assert.equal(config.idfPath, 'esp-idf');
    assert.equal(config.lvglDir, 'managed_components/lvgl__lvgl');

    assert.match(result.snippet, /#include "ui\.h"/);
    assert.match(result.snippet, /ui_start\(NULL\);/);
    assert.equal(integrationSnippet(config), result.snippet);

    // The managed component directory name is the REQUIRES name; the template
    // token must never leak into the generated project.
    const cmake = fs.readFileSync(path.join(uiDir, 'CMakeLists.txt'), 'utf8');
    assert.match(cmake, /REQUIRES\s+lvgl__lvgl\s+ui_port/);
    const portCmake = fs.readFileSync(path.join(portDir, 'CMakeLists.txt'), 'utf8');
    assert.match(portCmake, /REQUIRES\s+lvgl__lvgl/);
    assert.doesNotMatch(portCmake, /__LVGL_COMPONENT__/);
    const portImpl = fs.readFileSync(path.join(portDir, 'ui_port_impl.c'), 'utf8');
    assert.match(portImpl, /ui_port_get_temperature/);
    assert.ok(!cmake.includes('__LVGL_COMPONENT__'));

    const second = initProject(fixtureCtx(root));
    assert.equal(second.ok, false);
    assert.ok(second.problems.some((p) => p.includes('lvglui.json 已存在')));
    assert.deepEqual(second.created, []);
  } finally {
    cleanup(base);
  }
});

test('initProject rejects a uiDir that escapes the project root', () => {
  const { base, root } = makeRoot();
  try {
    const escaped = path.join(base, 'x');
    const result = initProject(fixtureCtx(root, { uiDir: '../x' }));

    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0);
    assert.ok(!fs.existsSync(escaped), 'wrote outside the project root');
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
    assert.deepEqual(result.created, []);
  } finally {
    cleanup(base);
  }
});

test('initProject refuses to invent a display size', () => {
  const { base, root } = makeRoot();
  try {
    const noDisplay = initProject(fixtureCtx(root, { display: null }));
    assert.equal(noDisplay.ok, false);
    assert.ok(noDisplay.problems.some((p) => /width|height|display|分辨率/i.test(p)));
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
    assert.ok(!fs.existsSync(path.join(root, 'components', 'app_ui')));

    // Half a pair is not a display either.
    const half = initProject(fixtureCtx(root, { display: undefined }), { width: 240 });
    assert.equal(half.ok, false);
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
    assert.ok(!fs.existsSync(path.join(root, 'components', 'app_ui')));
  } finally {
    cleanup(base);
  }
});

test('initProject rejects an existing uiDir containing a .c file', () => {
  const { base, root } = makeRoot();
  try {
    const uiDir = path.join(root, 'components', 'app_ui');
    fs.mkdirSync(path.join(uiDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(uiDir, 'src', 'legacy.c'), 'int legacy;\n');

    const result = initProject(fixtureCtx(root));

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('.c')));
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
    assert.ok(!fs.existsSync(path.join(uiDir, 'CMakeLists.txt')));
    assert.equal(fs.readFileSync(path.join(uiDir, 'src', 'legacy.c'), 'utf8'), 'int legacy;\n');
  } finally {
    cleanup(base);
  }
});

test('initProject refuses to overwrite an existing ui_port component', () => {
  const { base, root } = makeRoot();
  try {
    const portDir = path.join(root, 'components', 'ui_port');
    fs.mkdirSync(portDir, { recursive: true });
    fs.writeFileSync(path.join(portDir, 'ui_port_impl.c'), 'float ui_port_get_temperature(void){return 1;}\n');

    const result = initProject(fixtureCtx(root));

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('ui_port') && p.includes('.c')));
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
    assert.ok(!fs.existsSync(path.join(root, 'components', 'app_ui')));
    assert.equal(
      fs.readFileSync(path.join(portDir, 'ui_port_impl.c'), 'utf8'),
      'float ui_port_get_temperature(void){return 1;}\n',
    );
  } finally {
    cleanup(base);
  }
});

test('initProject accepts explicit width/height when ctx.display is absent', () => {
  const { base, root } = makeRoot();
  try {
    const result = initProject(fixtureCtx(root, { display: null }), { width: 240, height: 320 });

    assert.equal(result.ok, true, result.problems.join('; '));
    const config = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    assert.deepEqual(config.display, { width: 240, height: 320, colorDepth: 16 });
  } finally {
    cleanup(base);
  }
});

test('initProject rejects display dimensions outside the config range', () => {
  const { base, root } = makeRoot();
  try {
    // core/config.mjs only accepts 16..2048; init must not write a config that
    // every later command would reject.
    const result = initProject(fixtureCtx(root, { display: null }), { width: 2560, height: 1440 });

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('16') && p.includes('2048')));
    assert.deepEqual(result.created, []);
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
    assert.ok(!fs.existsSync(path.join(root, 'components', 'app_ui')));
  } finally {
    cleanup(base);
  }
});

test('initProject rejects a junction on a target ancestor', (t) => {
  const { base, root } = makeRoot();
  try {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(root, 'components');
    try {
      // A junction looks contained lexically but redirects every write.
      fs.symlinkSync(outside, link, 'junction');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'UNKNOWN') {
        t.skip(`junction creation not permitted: ${e.code}`);
        return;
      }
      throw e;
    }

    const result = initProject(fixtureCtx(root));

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => /符号链接|symlink|junction/i.test(p)));
    assert.deepEqual(result.created, []);
    assert.ok(!fs.existsSync(path.join(outside, 'app_ui')));
    assert.ok(!fs.existsSync(path.join(outside, 'lvglui.json')));
    assert.ok(!fs.existsSync(path.join(root, 'lvglui.json')));
  } finally {
    cleanup(base);
  }
});
