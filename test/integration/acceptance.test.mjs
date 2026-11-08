// Full acceptance on the real my_lcd project plus a synthetic ESP-IDF 6.x
// project. Run with `node --test --test-concurrency=1` so the two tests do not
// share the real project's .lvglui/build directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'cli/lvglui.mjs');
const PROJECT = 'D:/esps3_test/my_lcd';
const SKIP = fs.existsSync(PROJECT) ? false : `${PROJECT} not found`;
const BASELINE = '8f3a7ad7e177e94953547ae30e47149d5139de638d87a56449a2f9ea03ddd287';

function run(args, options = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    timeout: 180_000,
  });
  return { ...r, json: () => JSON.parse(r.stdout) };
}

test('my_lcd: doctor, render baseline and warm no-build', { skip: SKIP, timeout: 180_000 }, () => {
  const doctor = run(['doctor', '--project', PROJECT, '--width', '240', '--height', '320', '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(doctor.json().ok, true);

  const first = run(['render', '--project', PROJECT, '--width', '240', '--height', '320', '--json']);
  assert.equal(first.status, 0, first.stderr);
  const firstBody = first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.meta.png.sha256, BASELINE);
  assert.ok(firstBody.names.includes('val_temp'));

  const warm = run([
    'render', '--project', PROJECT, '--width', '240', '--height', '320', '--no-build', '--json',
  ]);
  assert.equal(warm.status, 0, warm.stderr);
  const warmBody = warm.json();
  assert.equal(warmBody.ok, true);
  assert.equal(warmBody.buildMs, 0);
  assert.equal(warmBody.meta.png.sha256, BASELINE);
});

test('synthetic IDF 6.x project: init creates only the UI component and config, then refuses', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-accept-'));
  const idf = path.join(tmp, 'idf');
  const lvgl = path.join(tmp, 'managed_components/lvgl__lvgl');
  try {
    fs.writeFileSync(path.join(tmp, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(demo C)\n');
    fs.mkdirSync(path.join(tmp, 'main'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'main/app_main.c'), 'void app_main(void) {}\n');
    fs.writeFileSync(path.join(tmp, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s3"\nCONFIG_LV_COLOR_DEPTH=16\n');

    fs.mkdirSync(path.join(idf, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(idf, 'tools/idf.py'), '');
    fs.mkdirSync(path.join(idf, 'components/esp_common/include'), { recursive: true });
    fs.writeFileSync(
      path.join(idf, 'components/esp_common/include/esp_idf_version.h'),
      '#define ESP_IDF_VERSION_MAJOR 6\n#define ESP_IDF_VERSION_MINOR 1\n#define ESP_IDF_VERSION_PATCH 0\n',
    );

    fs.mkdirSync(path.join(lvgl, 'src'), { recursive: true });
    fs.writeFileSync(path.join(lvgl, 'lvgl.h'), '#pragma once\n');
    fs.writeFileSync(path.join(lvgl, 'src/lvgl.h'), '#pragma once\n');
    fs.writeFileSync(path.join(lvgl, 'lv_version.h'), '#pragma once\n#define LVGL_VERSION_MAJOR 9\n#define LVGL_VERSION_MINOR 6\n#define LVGL_VERSION_PATCH 0\n');

    const init = run(
      ['init', '--project', tmp, '--width', '240', '--height', '320', '--no-render'],
      { env: { IDF_PATH: idf } },
    );
    assert.equal(init.status, 0, init.stderr);
    assert.ok(fs.existsSync(path.join(tmp, 'lvglui.json')));
    assert.ok(fs.existsSync(path.join(tmp, 'components/app_ui/include/ui.h')));
    assert.ok(fs.existsSync(path.join(tmp, 'components/app_ui/src/ui.c')));

    const second = run(
      ['init', '--project', tmp, '--width', '240', '--height', '320', '--no-render'],
      { env: { IDF_PATH: idf } },
    );
    assert.notEqual(second.status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});