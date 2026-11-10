import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagnostics } from '../../core/diagnostics.mjs';

test('parses MSVC error with file/line/col', () => {
  const text = 'D:\\proj\\components\\app_ui\\ui.c(12,5): error C2065: lv_label_set_text: undeclared identifier\n';
  const r = parseDiagnostics(text, { root: 'D:/proj', toolDir: 'D:/LVGL_preview' });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 12);
  assert.equal(r.errors[0].col, 5);
  assert.equal(r.errors[0].code, 'C2065');
  assert.match(r.errors[0].file, /app_ui[\\/]ui\.c$/);
});

test('caps at max and keeps raw lines', () => {
  const text = Array.from({ length: 60 }, (_, i) =>
    `D:\\proj\\ui.c(${i + 1},1): error C2065: bad\n`).join('');
  const r = parseDiagnostics(text, { root: 'D:/proj', toolDir: 'D:/LVGL_preview', max: 3 });
  assert.equal(r.errors.length, 3);
  assert.equal(r.summary.total, 60);
  assert.ok(r.errors[0].raw.includes('C2065'));
});
test('parses MSVC linker errors that have no line/column', () => {
  const text = [
    'home.c.obj : error LNK2019: 无法解析的外部符号 snprintf，函数 ui_page_home_create 中引用了该符号',
    'ui.dll : fatal error LNK1120: 1 个无法解析的外部命令',
  ].join('\r\n');
  const r = parseDiagnostics(text, { root: 'D:/proj', toolDir: 'D:/LVGL_preview' });
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].code, 'LNK2019');
  assert.equal(r.errors[0].line, 0);
  assert.equal(r.errors[0].file, 'home.c.obj');
  assert.match(r.errors[0].message, /snprintf/);
  assert.equal(r.errors[1].code, 'LNK1120');
  assert.equal(r.errors[1].severity, 'error');
  assert.equal(r.summary.errors, 2);
  assert.ok(r.hints.some((h) => h.includes('LNK error')));
});

test('explains C99 libc symbols missing under MSVC', () => {
  const r = parseDiagnostics(
    'a.c.obj : error LNK2019: unresolved external symbol snprintf referenced in function f\n');
  assert.ok(r.hints.some((h) => h.includes('lv_snprintf')));
});

test('parses GCC undefined references with their source position', () => {
  const r = parseDiagnostics("D:/proj/src/ui.c:12: undefined reference to `snprintf'\n", {
    root: 'D:/proj',
    toolDir: 'D:/LVGL_preview',
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 12);
  assert.equal(r.errors[0].file, 'src/ui.c');
  assert.match(r.errors[0].message, /undefined reference to snprintf/);
});

test('does not turn ordinary build prose into a link error', () => {
  const r = parseDiagnostics('ninja: error: loading build.ninja: no such file\n');
  assert.equal(r.errors.length, 0);
});
