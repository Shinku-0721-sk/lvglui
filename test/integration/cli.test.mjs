// End-to-end CLI test against the real project: build once, then render with
// --no-build --json. The project has no lvglui.json and no display geometry in
// sdkconfig, so both invocations must pass the CLI width/height pair; the tool
// never defaults to 240x320.
//
// The JSON contract matters to hosts: stdout must be exactly one parseable
// result object, and --no-build must not rebuild when shot.exe is already warm.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_DIR = 'D:/esps3_test/my_lcd';
const BASELINE_PNG_SHA256 = '8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287';
const CLI = path.resolve(import.meta.dirname, '../../cli/lvglui.mjs');
const SKIP = fs.existsSync(PROJECT_DIR) ? false : `${PROJECT_DIR} not found`;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
}

test('build once, then render --no-build --json matches the PNG baseline', {
  skip: SKIP,
  timeout: 20 * 60 * 1000,
}, () => {
  const build = runCli([
    'build',
    '--project', PROJECT_DIR,
    '--width', '240',
    '--height', '320',
  ]);
  assert.equal(
    build.status,
    0,
    `build failed (exit ${build.status})\nstdout: ${build.stdout}\nstderr: ${build.stderr}`,
  );

  const render = runCli([
    'render',
    '--project', PROJECT_DIR,
    '--width', '240',
    '--height', '320',
    '--no-build',
    '--json',
  ]);
  assert.equal(
    render.status,
    0,
    `render failed (exit ${render.status})\nstdout: ${render.stdout}\nstderr: ${render.stderr}`,
  );

  let result;
  assert.doesNotThrow(() => {
    result = JSON.parse(render.stdout);
  }, `stdout is not pure JSON:\n${render.stdout}`);
  assert.equal(result.ok, true);
  assert.equal(result.meta.png.sha256, BASELINE_PNG_SHA256);
  assert.equal(result.buildMs, 0, '--no-build rebuilt instead of reusing shot.exe');
  assert.ok(fs.existsSync(result.pngPath), `missing ${result.pngPath}`);
  assert.ok(fs.existsSync(result.metaPath), `missing ${result.metaPath}`);
});

test('doctor --json keeps stdout pure even when checks fail', {
  skip: SKIP,
}, () => {
  // No width/height and no display config: loadContext reports a problem and
  // doctor turns it into fail checks. stdout must still be one JSON object.
  const doctor = runCli(['doctor', '--project', PROJECT_DIR, '--json']);
  assert.equal(doctor.status, 1, `expected exit 1, got ${doctor.status}`);

  let result;
  assert.doesNotThrow(() => {
    result = JSON.parse(doctor.stdout);
  }, `stdout is not pure JSON:\n${doctor.stdout}`);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.problems) && result.problems.length > 0);
  assert.match(doctor.stderr, /--width/);
});

test('usage errors exit 2 without touching a project', () => {
  const unknown = runCli(['no-such-command']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知命令/);

  const badWidth = runCli(['render', '--width', 'abc']);
  assert.equal(badWidth.status, 2);
  assert.match(badWidth.stderr, /--width/);
});