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