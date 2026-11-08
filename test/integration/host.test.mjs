// Real host-build integration test: compile the tool against the my_lcd
// baseline project, render a headless frame and dump the widget tree.
//
// This test runs a full MSVC/LVGL compile, so it is slow (minutes on a cold
// build). It is skipped only when the baseline project or the C toolchain is
// absent; a compile failure is a test failure, never a skip.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadContext } from '../../core/context.mjs';
import { writeLvConf } from '../../core/kconfig.mjs';
import { findToolchain } from '../../core/toolchain.mjs';
import { buildHost } from '../../core/build.mjs';

const PROJECT_DIR = 'D:/esps3_test/my_lcd';
const PROJECT_UI_DIR = path.join(PROJECT_DIR, 'components/app_ui');

function present(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function tail(text, limit = 4000) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `...\n${value.slice(value.length - limit)}`;
}

function findByName(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (node.name === name) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const hit = findByName(child, name);
    if (hit) return hit;
  }
  return null;
}

function countNodes(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = 1;
  for (const child of Array.isArray(node.children) ? node.children : []) n += countNodes(child);
  return n;
}

const projectPresent = present(PROJECT_DIR) && present(PROJECT_UI_DIR);

test('host build renders my_lcd and dumps a widget tree', {
  skip: projectPresent ? false : `${PROJECT_DIR} (with components/app_ui) not found`,
}, (t) => {
  // my_lcd has no lvglui.json and no width/height in sdkconfig, so the CLI
  // pair is the only source of geometry.
  const ctx = loadContext({ projectDir: PROJECT_DIR, cliWidth: 240, cliHeight: 320 });
  assert.ok(ctx.ok, `loadContext failed:\n${ctx.problems.join('\n')}`);
  assert.ok(ctx.sdkconfig, 'my_lcd has no sdkconfig');
  assert.ok(ctx.lvgl.dir, 'LVGL directory was not found');

  // buildHost only builds; lv_conf.h must be generated first.
  writeLvConf({ sdkconfig: ctx.sdkconfig, lvglDir: ctx.lvgl.dir, out: ctx.lvConfPath });

  // loadContext never discovers the toolchain (doctor does that separately).
  const tc = findToolchain({ root: ctx.root, config: ctx.config, idf: ctx.idf, env: process.env });
  if (!tc.ok) {
    t.skip(`toolchain unavailable: ${tc.problems.join('; ')}`);
    return;
  }

  const buildCtx = {
    ...ctx,
    toolchain: { vcvars: tc.vcvars, cmake: tc.cmake, ninja: tc.ninja },
  };
  const build = buildHost(buildCtx);
  if (!build.ok) {
    let log = build.stderr;
    try {
      log = fs.readFileSync(build.logPath, 'utf8');
    } catch {
      // fall back to captured stderr
    }
    assert.fail(
      `buildHost failed (exit ${build.exitCode}, ${build.durationMs} ms)\n${tail(log)}`,
    );
  }
  t.diagnostic(`build took ${build.durationMs} ms`);

  // ui_dump_tree does not create the directory.
  fs.mkdirSync(ctx.outDir, { recursive: true });
  const rawPath = path.join(ctx.buildDir, '.fb.bin');
  const treePath = path.join(ctx.outDir, 'tree.json');

  const shot = spawnSync(
    path.join(ctx.buildDir, 'shot.exe'),
    ['--raw', rawPath, '--frames', '12', '--tree', treePath],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(
    shot.status,
    0,
    `shot.exe failed (status ${shot.status}):\n${tail(`${shot.stdout ?? ''}\n${shot.stderr ?? ''}`)}`,
  );

  // stdout contract for the raw path: the last line is "w h version raw"
  // (ui_attach's dump_names lines precede it).
  const resultLine = String(shot.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.match(
    resultLine,
    /^240 320 \d+ .*\.fb\.bin$/,
    `unexpected shot result line: ${JSON.stringify(resultLine)}`,
  );

  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
  t.diagnostic(`tree keys: ${Object.keys(tree).join(', ')}; nodes=${tree.nodes}`);
  assert.ok(tree.root && typeof tree.root === 'object', 'tree.root is missing');
  assert.ok(typeof tree.root.cls === 'string' && tree.root.cls.length > 0, 'tree.root.cls is empty');
  assert.ok(tree.nodes > 0, `tree.nodes must be > 0, got ${tree.nodes}`);
  assert.equal(countNodes(tree.root), tree.nodes, 'tree.nodes does not match the node count');

  const temp = findByName(tree.root, 'val_temp');
  assert.ok(temp, 'no object named "val_temp" in the tree');
  assert.equal(temp.cls, 'lv_label', `val_temp has class ${JSON.stringify(temp.cls)}`);
});