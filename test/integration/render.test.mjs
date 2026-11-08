// Real render integration test: build/run my_lcd, then check the deterministic
// PNG baseline and the widget tree. my_lcd has neither lvglui.json nor display
// geometry in sdkconfig, so geometry comes from the CLI pair (240x320).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadContext } from '../../core/context.mjs';
import { renderProject } from '../../core/render.mjs';

const PROJECT_DIR = 'D:/esps3_test/my_lcd';
const BASELINE_PNG_SHA256 = '8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287';

test('my_lcd renders baseline hash and tree', {
  skip: fs.existsSync(PROJECT_DIR) ? false : `${PROJECT_DIR} not found`,
}, () => {
  const ctx = loadContext({ projectDir: PROJECT_DIR, cliWidth: 240, cliHeight: 320 });
  assert.ok(ctx.ok, `loadContext failed:\n${ctx.problems.join('\n')}`);

  const r = renderProject(ctx, { frames: 12 });

  assert.equal(
    r.ok,
    true,
    `renderProject failed: ${r.error?.message ?? 'unknown error'}`,
  );
  assert.equal(r.meta.png.sha256, BASELINE_PNG_SHA256);
  assert.ok(r.names.includes('val_temp'), `names: ${r.names.join(', ')}`);
  assert.ok(r.treePath.endsWith('tree.json'));
  assert.ok(fs.existsSync(r.pngPath));
  assert.ok(fs.existsSync(r.metaPath));
});