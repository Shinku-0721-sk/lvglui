import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctor } from '../../core/doctor.mjs';

// The plan fixture pointed lvgl.dir at E:/lvgl, which does not exist, so the
// lvgl check could never pass. Build a real <root>/lvgl/src instead; idf is
// version-checked only (a fake path is fine, the directory is created so the
// project check sees a plausible root).
function ctx(t, uiSource, { cmake = null, sdkconfig = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-doc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const uiDir = path.join(root, 'components', 'app_ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'ui.c'), uiSource);
  if (cmake !== null) fs.writeFileSync(path.join(uiDir, 'CMakeLists.txt'), cmake);

  const idfDir = path.join(root, 'idf');
  fs.mkdirSync(idfDir, { recursive: true });

  const lvglDir = path.join(root, 'lvgl');
  fs.mkdirSync(path.join(lvglDir, 'src'), { recursive: true });

  return {
    ok: true,
    root,
    uiDir,
    entry: 'ui_start',
    sources: [path.join(uiDir, 'ui.c')],
    idf: { path: idfDir, version: { major: 6, minor: 1 } },
    lvgl: { dir: lvglDir, version: { major: 9, minor: 6 } },
    display: { width: 240, height: 320, colorDepth: 16, source: 'config' },
    sdkconfig,
    config: { font: { cjk: true } },
  };
}

const CLEAN_UI = '#include "lvgl.h"\nvoid ui_start(void){}\n';

test('doctor before init warns on uiDir/entry instead of failing', (t) => {
  const project = ctx(t, CLEAN_UI);
  // Nothing injected yet: no config file, no entry, no UI directory at all.
  project.configFile = null;
  project.uiDir = '';
  project.entry = '';
  project.sources = [];

  const r = doctor(project, { toolchain: { ok: true } });

  assert.equal(r.ok, true);
  const byId = new Map(r.checks.map((c) => [c.id, c]));
  assert.equal(byId.get('uiDir').status, 'warn');
  assert.match(byId.get('uiDir').message, /lvglui init/);
  assert.equal(byId.get('entry').status, 'warn');
});

test('a config that points at a missing uiDir is a fail', (t) => {
  const project = ctx(t, CLEAN_UI);
  project.configFile = path.join(project.root, 'lvglui.json');
  project.uiDir = path.join(project.root, 'components', 'gone');

  const r = doctor(project, { toolchain: { ok: true } });

  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.id === 'uiDir'));
});

test('platform header include is a fail', (t) => {
  const project = ctx(t, '#include "driver/gpio.h"\nvoid ui_start(void){}\n');
  const r = doctor(project, { toolchain: { ok: true } });

  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /平台头文件/.test(p.message)));
  assert.equal(r.checks.find((c) => c.id === 'platformHeaders').status, 'fail');
});

test('clean ui is ok with warnings only', (t) => {
  const r = doctor(ctx(t, CLEAN_UI), { toolchain: { ok: true } });

  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.checks.find((c) => c.id === 'lvgl').status, 'ok');
  assert.equal(r.checks.find((c) => c.id === 'srces').status, 'warn');
});

test('srces without CMakeLists only warns', (t) => {
  const r = doctor(ctx(t, CLEAN_UI), { toolchain: { ok: true } });
  assert.equal(r.checks.find((c) => c.id === 'srces').status, 'warn');
});

test('srces fails when a UI source is missing from SRCS', (t) => {
  const project = ctx(t, CLEAN_UI, { cmake: 'idf_component_register(SRCS "ui.c")\n' });
  fs.writeFileSync(path.join(project.uiDir, 'extra.c'), 'void extra(void){}\n');
  const r = doctor(project, { toolchain: { ok: true } });

  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.id === 'srces').status, 'fail');
  assert.ok(r.problems.some((p) => p.message.includes('extra.c')));
});

test('missing toolchain warns instead of failing', (t) => {
  const r = doctor(ctx(t, CLEAN_UI));

  assert.equal(r.ok, true);
  assert.equal(r.checks.find((c) => c.id === 'toolchain').status, 'warn');
  assert.equal(r.warnings.some((w) => w.id === 'toolchain'), true);
});

test('sdkconfig as a path string is parsed for the font check', (t) => {
  const project = ctx(t, CLEAN_UI, { sdkconfig: null });
  const file = path.join(project.root, 'sdkconfig');
  fs.writeFileSync(file, 'CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_16_CJK=y\n');
  project.sdkconfig = file;
  project.config = { font: { cjk: false } };

  const r = doctor(project, { toolchain: { ok: true } });
  assert.equal(r.checks.find((c) => c.id === 'font').status, 'ok');
});
test('reports its own version and CLI path', (t) => {
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-tool-'));
  t.after(() => fs.rmSync(toolDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(toolDir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const project = ctx(t, CLEAN_UI);
  project.toolDir = toolDir;
  const r = doctor(project);
  const check = r.checks.find((c) => c.id === 'tool');
  assert.equal(check.status, 'ok');
  assert.match(check.message, /lvglui 9\.9\.9/);
  assert.match(check.message, /cli\/lvglui\.mjs/);
});

test('uiPort warns when a declared accessor has no definition', (t) => {
  const project = ctx(t, CLEAN_UI);
  const port = path.join(project.root, 'components', 'ui_port');
  fs.mkdirSync(path.join(port, 'include'), { recursive: true });
  fs.writeFileSync(
    path.join(port, 'include', 'ui_port.h'),
    '#pragma once\nfloat ui_port_get_lux(void);\n',
  );
  fs.writeFileSync(
    path.join(port, 'ui_port_impl.c'),
    'float ui_port_get_temperature(void) { return 0; }\n',
  );
  project.portInclude = path.join(port, 'include');
  project.configFile = 'lvglui.json';
  const r = doctor(project);
  const check = r.checks.find((c) => c.id === 'uiPort');
  assert.equal(check.status, 'warn');
  assert.match(check.message, /ui_port_get_lux/);
  assert.match(check.message, /undefined reference/);
});

test('objName warns when firmware disables names but the UI uses them', (t) => {
  const project = ctx(
    t,
    '#include "lvgl.h"\nvoid ui_start(lv_obj_t *p){ lv_obj_set_name(p, "x"); }\n',
  );
  const r = doctor(project);
  const check = r.checks.find((c) => c.id === 'objName');
  assert.equal(check.status, 'warn');
  assert.match(check.message, /lv_obj_set_name/);
});
