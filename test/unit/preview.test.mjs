import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { previewArgs } from '../../core/preview.mjs';

// Absolute paths on purpose: previewArgs must pass them through unchanged and
// never reconstruct them from the executable location.
function projectCtx(overrides = {}) {
  return {
    toolDir: 'D:/LVGL_preview',
    root: 'D:/proj',
    buildDir: 'D:/proj/.lvglui/build',
    uiDir: 'D:/proj/components/app_ui',
    lvConfPath: 'D:/proj/.lvglui/build/lv_conf.h',
    entry: 'ui_start',
    display: { width: 240, height: 320 },
    lvgl: { dir: 'D:/proj/managed_components/lvgl__lvgl' },
    ...overrides,
  };
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

test('previewArgs builds the full parameterized command line', () => {
  const ctx = projectCtx();

  const args = previewArgs(ctx);

  assert.deepEqual(args, [
    '--dll', path.join(ctx.buildDir, 'ui.dll'),
    '--project', ctx.root,
    '--ui-dir', ctx.uiDir,
    '--build-dir', ctx.buildDir,
    '--build-cmd', path.join(ctx.buildDir, 'build.cmd'),
    '--width', '240',
    '--height', '320',
  ]);
  assert.equal(args.length, 14);
});

test('previewArgs never emits the legacy exe-relative paths', () => {
  const ctx = projectCtx();
  const args = previewArgs(ctx);
  const dll = valueOf(args, '--dll');
  const buildCmd = valueOf(args, '--build-cmd');

  // The old shell guessed "<exe dir>/build/ui.dll" and "<exe dir>/ui".
  assert.equal(path.basename(dll), 'ui.dll');
  assert.equal(dll, path.join(ctx.buildDir, 'ui.dll'));
  assert.equal(path.basename(buildCmd), 'build.cmd');
  assert.equal(buildCmd, path.join(ctx.buildDir, 'build.cmd'));
  assert.ok(!args.some((arg) => /build(-cli)?\.bat$/i.test(arg)));
  assert.ok(!args.some((arg) => /[\\/]ui[\\/]/i.test(arg)));
});

test('previewArgs preserves spaces in paths', () => {
  const ctx = projectCtx({
    root: 'D:/my project',
    buildDir: 'D:/my project/.lvglui/build dir',
    uiDir: 'D:/my project/components/app ui',
  });

  const args = previewArgs(ctx, { buildCmd: 'D:/my project/build tools/run build.cmd' });

  assert.equal(valueOf(args, '--dll'), 'D:/my project/.lvglui/build dir/ui.dll'.replace(/\//g, path.sep));
  assert.equal(valueOf(args, '--project'), 'D:/my project');
  assert.equal(valueOf(args, '--ui-dir'), 'D:/my project/components/app ui');
  assert.equal(valueOf(args, '--build-dir'), 'D:/my project/.lvglui/build dir');
  assert.equal(valueOf(args, '--build-cmd'), 'D:/my project/build tools/run build.cmd');
  // The argv array, not a shell string, carries each space verbatim.
  assert.equal(args[args.indexOf('--ui-dir') + 1], 'D:/my project/components/app ui');
});

test('previewArgs appends extra watch paths as repeated --watch pairs', () => {
  const ctx = projectCtx();

  const args = previewArgs(ctx, {
    extraWatch: ['D:/proj/sdkconfig', 'D:/proj/extra/theme.c'],
  });

  assert.deepEqual(args.slice(-4), [
    '--watch', 'D:/proj/sdkconfig',
    '--watch', 'D:/proj/extra/theme.c',
  ]);
});