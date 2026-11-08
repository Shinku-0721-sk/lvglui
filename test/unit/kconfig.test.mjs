import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_OVERRIDES,
  applyOverrides,
  loadTemplateOptions,
  parseSdkconfig,
  translate,
  writeLvConf,
} from '../../core/kconfig.mjs';

function tempDir(t, prefix = 'lvglui-kconfig-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const DEFAULT_TEMPLATE = [
  '#ifndef LV_CONF_TEMPLATE_H',
  '#define LV_CONF_TEMPLATE_H',
  '#define LV_COLOR_DEPTH 16',
  '// #define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565',
  '#define LV_USE_OBJ_NAME 0',
  '#define LV_USE_FLEX 0',
  '#define LV_USE_GRID 0',
  '#define LV_USE_THEME_SIMPLE 0',
  '#define LV_USE_THEME_DEFAULT 0',
  '#define LV_FONT_MONTSERRAT_14 0',
  '#define LV_FONT_MONTSERRAT_16 0',
  '#define LV_FONT_SOURCE_HAN_SANS_SC_14_CJK 0',
  '#define LV_FONT_SOURCE_HAN_SANS_SC_16_CJK 0',
  '#endif',
].join('\n') + '\n';

const DEFAULT_SDKCONFIG = [
  'CONFIG_LV_COLOR_DEPTH=16',
  '# CONFIG_LV_USE_OBJ_NAME is not set',
  'CONFIG_LV_USE_FLEX=y',
  'CONFIG_LV_USE_THEME_SIMPLE=y',
  'CONFIG_LV_FONT_MONTSERRAT_14=y',
  'CONFIG_LV_CONF_SKIP=n',
  'CONFIG_LV_NOT_AN_OPTION=1',
].join('\n') + '\n';

/** Real temp project: sdkconfig + LVGL dir with lv_conf_template.h. */
function makeProject(t, { sdkconfig = DEFAULT_SDKCONFIG, template = DEFAULT_TEMPLATE } = {}) {
  const root = tempDir(t);
  const sdkconfigFile = path.join(root, 'project', 'sdkconfig');
  write(sdkconfigFile, sdkconfig);
  const lvglDir = path.join(root, 'managed_components', 'lvgl__lvgl');
  write(path.join(lvglDir, 'lv_conf_template.h'), template);
  return {
    root,
    sdkconfig: sdkconfigFile,
    lvglDir,
    out: path.join(root, 'build', 'lv_conf.h'),
  };
}

test('translate drops build-only, deprecated, empty and unknown options, keeps known ones', () => {
  const kconfig = new Map(Object.entries({
    LV_COLOR_DEPTH: 16,
    LV_CONF_SKIP: 1,
    LV_BUILD_EXAMPLES: 0,
    LV_USE_OBJ_NAME: 1,
    LV_USE_FLEX: 0,
    LV_UNKNOWN: 1,
    LV_ASSERT_HANDLER_INCLUDE: '',
  }));
  const templateSet = new Set([
    'LV_COLOR_DEPTH', 'LV_USE_OBJ_NAME', 'LV_USE_FLEX', 'LV_ASSERT_HANDLER_INCLUDE',
  ]);

  const res = translate(kconfig, templateSet);

  assert.equal(res.emitted, 2);
  assert.deepEqual(res.skippedBuild, ['LV_CONF_SKIP', 'LV_BUILD_EXAMPLES']);
  assert.deepEqual(res.droppedDeprecated, ['LV_COLOR_DEPTH']);
  assert.deepEqual(res.skippedUnknown, ['LV_UNKNOWN']);
  assert.deepEqual(res.droppedEmpty, ['LV_ASSERT_HANDLER_INCLUDE']);
  assert.match(res.text, /^#define LV_USE_OBJ_NAME 1$/m);
  assert.match(res.text, /^#define LV_USE_FLEX 0$/m);
  assert.doesNotMatch(res.text, /^#define LV_COLOR_DEPTH/m);
  assert.match(res.text, /^#ifndef LV_CONF_H\n#define LV_CONF_H$/m);
  assert.match(res.text, /lvglui\/core\/kconfig\.mjs/);
  assert.ok(res.text.endsWith('#endif /* LV_CONF_H */\n'));
});

test('applyOverrides replaces existing keys and appends a missing key exactly once', () => {
  const text = [
    '#define LV_USE_OBJ_NAME 0',
    '#define LV_USE_THEME_SIMPLE 0',
    '#define LV_USE_FLEX 0',
    '#endif /* LV_CONF_H */',
    '',
  ].join('\n');
  const out = applyOverrides(text, {
    LV_USE_OBJ_NAME: '1',
    LV_USE_THEME_SIMPLE: '1',
    LV_USE_FLEX: '1',
    LV_FONT_MONTSERRAT_14: '1',
  });

  assert.match(out, /^#define LV_USE_OBJ_NAME 1$/m);
  assert.match(out, /^#define LV_USE_THEME_SIMPLE 1$/m);
  assert.match(out, /^#define LV_USE_FLEX 1$/m);
  assert.equal(out.match(/^#define LV_USE_FLEX\b/gm).length, 1);
  assert.equal(out.match(/^#define LV_FONT_MONTSERRAT_14\b/gm).length, 1);
  assert.match(out, /#ifndef LV_FONT_MONTSERRAT_14\n#define LV_FONT_MONTSERRAT_14 1\n#endif/);
});

test('applyOverrides inserts missing keys before the final LV_CONF_H guard', () => {
  const text = [
    '#ifndef LV_CONF_H',
    '#define LV_CONF_H',
    '',
    '#define LV_USE_FLEX 1',
    '',
    '#endif /* LV_CONF_H */',
    '',
  ].join('\n');
  const out = applyOverrides(text, { LV_USE_GRID: '1' });

  const marker = out.lastIndexOf('#endif /* LV_CONF_H */');
  const block = out.indexOf('#ifndef LV_USE_GRID');
  assert.ok(block > 0, 'missing key block must be appended');
  assert.ok(block < marker, 'missing key block must sit before the final guard');
  assert.match(
    out,
    /#ifndef LV_USE_GRID\n#define LV_USE_GRID 1\n#endif\n#endif \/\* LV_CONF_H \*\//,
  );
  assert.ok(out.startsWith('#ifndef LV_CONF_H\n#define LV_CONF_H\n\n#define LV_USE_FLEX 1'));
});

test('applyOverrides appends at the end when the LV_CONF_H marker is absent', () => {
  const text = '#define LV_USE_FLEX 1\n';
  const out = applyOverrides(text, { LV_USE_GRID: '1' });

  assert.ok(out.startsWith(text));
  assert.match(out, /#ifndef LV_USE_GRID\n#define LV_USE_GRID 1\n#endif\n$/);
});

test('parseSdkconfig reads set/unset values, numbers and quoted strings', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'sdkconfig');
  write(file, [
    'CONFIG_LV_USE_FLEX=y',
    '# CONFIG_LV_USE_GRID is not set',
    'CONFIG_LV_DEFINE_VALUE=42',
    'CONFIG_LV_SPRINTF_CUSTOM="a\\"b"',
    'not a config line',
  ].join('\n') + '\n');

  const map = parseSdkconfig(file);

  assert.equal(map.get('LV_USE_FLEX'), 1);
  assert.equal(map.get('LV_USE_GRID'), 0);
  assert.equal(map.get('LV_DEFINE_VALUE'), 42);
  assert.equal(map.get('LV_SPRINTF_CUSTOM'), 'a"b');
  assert.equal(map.has('not'), false);
});

test('loadTemplateOptions collects #define and // #define options and returns null without a template', (t) => {
  const dir = tempDir(t);
  assert.equal(loadTemplateOptions(dir), null);

  write(path.join(dir, 'lv_conf_template.h'), [
    '#define LV_USE_FLEX 0',
    '// #define LV_USE_GRID 0',
    '#define NOT_LV_THING 1',
  ].join('\n') + '\n');

  const set = loadTemplateOptions(dir);
  assert.ok(set.has('LV_USE_FLEX'));
  assert.ok(set.has('LV_USE_GRID'));
  assert.equal(set.has('NOT_LV_THING'), false);
});

test('writeLvConf translates and applies the default overrides exactly once', (t) => {
  const { sdkconfig, lvglDir, out } = makeProject(t);

  const r = writeLvConf({ sdkconfig, lvglDir, out });

  assert.equal(r.changed, true);
  assert.equal(r.written, true);
  const text = fs.readFileSync(out, 'utf8');
  assert.equal(text, r.text);
  assert.match(text, /^#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565$/m);
  assert.doesNotMatch(text, /^#define LV_COLOR_DEPTH/m);
  assert.match(text, /^#define LV_USE_OBJ_NAME 1$/m);
  assert.match(text, /^#define LV_FONT_SOURCE_HAN_SANS_SC_14_CJK 1$/m);
  assert.deepEqual(r.droppedDeprecated, ['LV_COLOR_DEPTH']);
  assert.ok(r.skippedBuild.includes('LV_CONF_SKIP'));
  assert.deepEqual(r.skippedUnknown, ['LV_NOT_AN_OPTION']);

  for (const [key, value] of Object.entries(DEFAULT_OVERRIDES)) {
    assert.equal(
      (text.match(new RegExp(`^#define ${key}\\s+`, 'gm')) || []).length,
      1,
      `${key} must appear exactly once`,
    );
    assert.match(text, new RegExp(`^#define ${key} ${value}$`, 'm'));
  }
});

test('writeLvConf does not rewrite or touch mtime when the text is unchanged', (t) => {
  const { sdkconfig, lvglDir, out } = makeProject(t);

  const first = writeLvConf({ sdkconfig, lvglDir, out });
  assert.equal(first.changed, true);

  // Fixed old mtime: any rewrite would move it to "now".
  const fixed = new Date(1000);
  fs.utimesSync(out, fixed, fixed);
  const before = fs.statSync(out).mtimeMs;
  assert.ok(before < 2000, `fixed mtime must be applied, got ${before}`);

  const second = writeLvConf({ sdkconfig, lvglDir, out });

  assert.equal(second.changed, false);
  assert.equal(second.written, false);
  assert.equal(fs.statSync(out).mtimeMs, before);
  assert.equal(fs.readFileSync(out, 'utf8'), first.text);
});

test('writeLvConf applies post after the overrides', (t) => {
  const { sdkconfig, lvglDir, out } = makeProject(t);

  const post = (text) => text.replace(/^#define LV_USE_OBJ_NAME 1$/m, '#define LV_USE_OBJ_NAME 0');
  const r = writeLvConf({ sdkconfig, lvglDir, out, post });

  // If post ran before the overrides, the override would put 1 back.
  assert.match(r.text, /^#define LV_USE_OBJ_NAME 0$/m);
  assert.doesNotMatch(r.text, /^#define LV_USE_OBJ_NAME 1$/m);
  assert.equal(fs.readFileSync(out, 'utf8'), r.text);
});

test('custom overrides replace the default set instead of merging', (t) => {
  const { sdkconfig, lvglDir, out } = makeProject(t, {
    sdkconfig: 'CONFIG_LV_USE_FLEX=n\n',
    template: '#define LV_USE_FLEX 0\n',
  });

  const r = writeLvConf({ sdkconfig, lvglDir, out, overrides: { LV_USE_FLEX: '0' } });

  assert.match(r.text, /^#define LV_USE_FLEX 0$/m);
  assert.doesNotMatch(r.text, /LV_COLOR_FORMAT_DEFAULT/);
  assert.doesNotMatch(r.text, /LV_FONT_SOURCE_HAN_SANS_SC_14_CJK/);
  assert.doesNotMatch(r.text, /LV_USE_OBJ_NAME/);
});