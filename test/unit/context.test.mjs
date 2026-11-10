import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadContext } from '../../core/context.mjs';

const TOOL_DIR = path.resolve(import.meta.dirname, '..', '..');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-ctx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Plan fixture, with the sdkconfig text, UI source text and lvglui.json data
// adjustable so the failure and init paths can reuse it.
function project(t, { sdkconfig = 'CONFIG_LV_COLOR_DEPTH=16\n', uiSource, config } = {}) {
  const root = tempRoot(t);

  if (uiSource !== null) {
    writeFile(
      path.join(root, 'components', 'app_ui', 'ui.c'),
      uiSource ?? 'lv_obj_t *ui_start(lv_obj_t *p){ return p; }\n',
    );
  }
  writeFile(path.join(root, 'CMakeLists.txt'), 'project(demo)\n');
  writeFile(path.join(root, 'sdkconfig'), sdkconfig);

  const idf = path.join(root, 'idf');
  writeFile(path.join(idf, 'tools', 'idf.py'));
  writeFile(
    path.join(idf, 'components', 'esp_common', 'include', 'esp_idf_version.h'),
    '#define ESP_IDF_VERSION_MAJOR 6\n#define ESP_IDF_VERSION_MINOR 1\n#define ESP_IDF_VERSION_PATCH 0\n',
  );

  const lvgl = path.join(root, 'lvgl');
  fs.mkdirSync(path.join(lvgl, 'src'), { recursive: true });
  writeFile(path.join(lvgl, 'lvgl.h'));
  writeFile(
    path.join(lvgl, 'lv_version.h'),
    '#define LVGL_VERSION_MAJOR 9\n#define LVGL_VERSION_MINOR 6\n#define LVGL_VERSION_PATCH 0\n',
  );

  const data = {
    schema: 1,
    idfPath: idf,
    lvglDir: lvgl,
    ...config,
  };
  if (!('uiDir' in data)) data.uiDir = 'components/app_ui';
  if (!('entry' in data)) data.entry = 'ui_start';
  if (!('display' in data)) data.display = { width: 240, height: 320, colorDepth: 16 };
  writeFile(path.join(root, 'lvglui.json'), JSON.stringify(data));
  return root;
}

test('loads config and derives paths', (t) => {
  const root = project(t);
  const ctx = loadContext({ projectDir: root });

  assert.equal(ctx.ok, true);
  assert.equal(ctx.root, path.resolve(root));
  assert.equal(ctx.configFile, path.resolve(root, 'lvglui.json'));
  assert.equal(ctx.uiDir, path.resolve(root, 'components/app_ui'));
  assert.equal(ctx.entry, 'ui_start');
  assert.equal(ctx.entryHow, 'config');
  assert.deepEqual(ctx.sources, [path.resolve(root, 'components/app_ui/ui.c')]);
  assert.equal(ctx.buildDir, path.resolve(root, '.lvglui/build'));
  assert.equal(ctx.stateDir, path.resolve(root, '.lvglui'));
  assert.equal(ctx.outDir, path.resolve(root, '.lvglui/out'));
  assert.equal(ctx.lvConfPath, path.resolve(root, '.lvglui/build/lv_conf.h'));
  assert.equal(ctx.sdkconfig, path.resolve(root, 'sdkconfig'));
  assert.equal(ctx.display.source, 'config');
  assert.deepEqual([ctx.display.width, ctx.display.height, ctx.display.colorDepth], [240, 320, 16]);
  assert.equal(ctx.idf.version.major, 6);
  assert.equal(ctx.idf.path, path.resolve(root, 'idf'));
  assert.equal(ctx.lvgl.version.major, 9);
  assert.equal(ctx.lvgl.dir, path.resolve(root, 'lvgl'));
  assert.equal(ctx.toolDir, TOOL_DIR);
  assert.ok(path.isAbsolute(ctx.toolDir));
  assert.ok(fs.statSync(ctx.toolDir).isDirectory());
  assert.ok(fs.existsSync(path.join(ctx.toolDir, 'CMakeLists.txt')));
  assert.equal(ctx.portInclude, null);
  assert.deepEqual(ctx.problems, []);
  assert.ok(Array.isArray(ctx.warnings));
});

test('finds the ui_port include dir of the generated layout', (t) => {
  const root = project(t);
  const portInclude = path.join(root, 'components', 'ui_port', 'include');
  writeFile(path.join(portInclude, 'ui_port.h'), '#pragma once\n');

  const ctx = loadContext({ projectDir: root });

  assert.equal(ctx.ok, true, ctx.problems.join('; '));
  assert.equal(ctx.portInclude, portInclude);
});

test('fails without a resolution instead of defaulting to 240x320', (t) => {
  const root = project(t, {
    config: { display: null },
    uiSource: 'void ui_start(void) {}\n',
  });
  const ctx = loadContext({ projectDir: root });

  assert.equal(ctx.ok, false);
  assert.ok(ctx.problems.length > 0);
  assert.match(ctx.problems.join('\n'), /resolution/);
  assert.equal(ctx.display.width, null);
  assert.equal(ctx.display.height, null);
  assert.equal(ctx.display.colorDepth, null);
  assert.equal(ctx.display.source, null);
  assert.ok(ctx.display.problem);
  assert.equal(ctx.toolDir, TOOL_DIR);
});

test('requireUi:false succeeds without a UI directory or entry', (t) => {
  const root = project(t, {
    uiSource: null,
    config: { uiDir: '', entry: '' },
  });
  fs.rmSync(path.join(root, 'components'), { recursive: true, force: true });

  const ctx = loadContext({ projectDir: root, requireUi: false });

  assert.equal(ctx.ok, true);
  assert.equal(ctx.uiDir, null);
  assert.equal(ctx.entry, null);
  assert.equal(ctx.entryHow, null);
  assert.deepEqual(ctx.sources, []);
  assert.equal(ctx.idf.version.major, 6);
  assert.equal(ctx.lvgl.version.major, 9);
  assert.equal(ctx.display.source, 'config');
  assert.equal(ctx.toolDir, TOOL_DIR);
});