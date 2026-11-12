// A failed build must carry the parsed diagnostics and the build log path, so
// callers can show actionable output instead of only "build failed".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderProject } from '../../core/render.mjs';

const TOOL_DIR = path.resolve(import.meta.dirname, '../..');

test('build failure exposes diagnostics and the build log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-render-fail-'));
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const ctx = {
    ok: true,
    toolDir: TOOL_DIR,
    root,
    buildDir,
    outDir: path.join(root, 'out'),
    lvConfPath: path.join(buildDir, 'lv_conf.h'),
    uiDir: path.join(root, 'ui'),
    entry: 'ui_start',
    sources: [],
    lvgl: { dir: path.join(root, 'lvgl'), version: '9.6.0' },
    idf: null,
    display: { width: 24, height: 32, colorDepth: 16 },
    config: {},
    sdkconfig: null,
    // Explicit, complete-looking paths: the build is attempted (and fails)
    // without invoking toolchain discovery.
    toolchain: {
      vcvars: 'Z:/no-such-toolchain/vcvars64.bat',
      cmake: 'Z:/no-such-toolchain/cmake.exe',
      ninja: 'Z:/no-such-toolchain/ninja.exe',
    },
  };

  try {
    const r = renderProject(ctx, { frames: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error?.stage, 'build');
    assert.match(r.error.message, /build failed/);
    assert.equal(r.error.diagnostics, r.diagnostics);
    assert.ok(Array.isArray(r.diagnostics.errors));
    assert.equal(typeof r.error.buildLog, 'string');
    assert.ok(r.error.buildLog.length > 0, 'error.buildLog should name the log');
    assert.ok(fs.existsSync(r.error.buildLog), `missing build log ${r.error.buildLog}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function scrollCtx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-scroll-'));
  return {
    ctx: {
      ok: true,
      toolDir: TOOL_DIR,
      root,
      buildDir: path.join(root, 'build'),
      outDir: path.join(root, 'out'),
      lvConfPath: path.join(root, 'build', 'lv_conf.h'),
      uiDir: path.join(root, 'ui'),
      entry: 'ui_start',
      sources: [],
      lvgl: { dir: path.join(root, 'lvgl'), version: '9.6.0' },
      idf: null,
      display: { width: 240, height: 320, colorDepth: 16 },
      config: {},
      sdkconfig: null,
      // No toolchain: any attempt to build before validating --scroll would
      // fail with stage "toolchain" and expose the ordering mistake.
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('--scroll without a value fails before building', () => {
  const { ctx, cleanup } = scrollCtx();
  try {
    const r = renderProject(ctx, { scroll: '' });
    assert.equal(r.ok, false);
    assert.equal(r.error?.stage, 'scroll');
    assert.match(r.error.message, /needs a value/);
  } finally {
    cleanup();
  }
});

test('--scroll cannot be combined with --all-pages', () => {
  const { ctx, cleanup } = scrollCtx();
  try {
    const r = renderProject(ctx, { scroll: '120', allPages: true });
    assert.equal(r.ok, false);
    assert.equal(r.error?.stage, 'scroll');
    assert.match(r.error.message, /cannot be combined/);
  } finally {
    cleanup();
  }
});
