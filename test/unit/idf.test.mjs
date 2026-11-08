import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findIdf, readIdfVersion } from '../../core/idf.mjs';

const HEADER = path.join('components', 'esp_common', 'include', 'esp_idf_version.h');

function makeIdfAt(dir, major = 6, minor = 1, patch = 0) {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(dir, HEADER)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'idf.py'), '');
  fs.writeFileSync(
    path.join(dir, HEADER),
    `#define ESP_IDF_VERSION_MAJOR ${major}\n#define ESP_IDF_VERSION_MINOR ${minor}\n#define ESP_IDF_VERSION_PATCH ${patch}\n`,
  );
  return dir;
}

function makeIdf(major = 6, minor = 1, patch = 0) {
  return makeIdfAt(fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-idf-')), major, minor, patch);
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-proj-'));
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(demo)\n');
  return root;
}

function headerPath(idf) {
  return path.join(idf, HEADER);
}

test('readIdfVersion reads 6.1.0 from a fixture header', () => {
  const idf = makeIdf(6, 1, 0);
  const r = readIdfVersion(idf);
  assert.equal(r.ok, true);
  assert.deepEqual(r.version, { major: 6, minor: 1, patch: 0 });
  assert.equal(r.problem, null);
  assert.equal(r.header, headerPath(idf));
});

test('findIdf rejects a 5.3 IDF from config.idfPath and names 6.x', () => {
  const root = makeProject();
  const idf = makeIdf(5, 3, 0);
  const r = findIdf({ root, config: { idfPath: idf }, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'config');
  assert.equal(r.path, path.resolve(idf));
  assert.equal(r.version.major, 5);
  assert.match(r.problem, /需要 ESP-IDF 6\.x/);
  assert.match(r.problem, /5\.3\.0/);
});

test('project_description beats a stale env IDF_PATH', () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const good = makeIdf(6, 1, 0);
  const stale = makeIdf(5, 3, 0);
  fs.writeFileSync(
    path.join(root, 'build', 'project_description.json'),
    JSON.stringify({ idf_path: good, project_name: 'demo' }),
  );
  const r = findIdf({ root, config: {}, env: { IDF_PATH: stale } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'project-description');
  assert.equal(r.path, path.resolve(good));
  assert.equal(r.version.major, 6);
  assert.equal(r.problem, null);
});

test('findIdf parses JSONC .vscode/settings.json without corrupting Windows paths', () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
  const idf = makeIdf(6, 2, 1);
  const settings = `{
  // The ESP-IDF extension stores the selected toolchain here.
  "idf.currentSetup": ${JSON.stringify(idf)},
  /* Strings that contain comment-like text must survive stripping. */
  "idf.customExtraVars": {
    "MY_PATH": "D://esp//tools;D:/other",
    "DOC_URL": "http://example.com/*keep*/"
  }
}
`;
  fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), settings);
  const r = findIdf({ root, config: {}, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'vscode');
  assert.equal(r.path, path.resolve(idf));
  assert.equal(r.version.major, 6);
  assert.equal(r.version.minor, 2);
});

test('findIdf lists every tried candidate path and reason when all are missing', () => {
  const root = makeProject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-missing-'));
  const configPath = path.join(base, 'configured-idf');
  const envPath = path.join(base, 'env-idf');
  const r = findIdf({ root, config: { idfPath: configPath }, env: { IDF_PATH: envPath } });
  assert.equal(r.ok, false);
  assert.equal(r.path, null);
  assert.equal(r.source, null);
  assert.equal(r.version, null);
  assert.match(r.problem, /config\.idfPath/);
  assert.match(r.problem, /project_description\.json/);
  assert.match(r.problem, /\.vscode[/\\]settings\.json/);
  assert.match(r.problem, /IDF_PATH/);
  assert.ok(r.problem.includes(configPath), 'problem should name the configured path');
  assert.ok(r.problem.includes(envPath), 'problem should name the env path');
  assert.ok(r.problem.split('\n').length >= 4, 'problem should list one line per candidate');
});

test('findIdf fails with the header path when the marker exists but the header is missing', () => {
  const root = makeProject();
  const idf = makeIdf(6, 1, 0);
  fs.rmSync(headerPath(idf));
  const r = findIdf({ root, config: { idfPath: idf }, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'config');
  assert.equal(r.path, path.resolve(idf));
  assert.equal(r.version, null);
  assert.match(r.problem, /esp_idf_version\.h/);
  assert.ok(r.problem.includes(headerPath(idf)), 'problem should name the missing header');
});

test('readIdfVersion reports a malformed header without throwing', () => {
  const idf = makeIdf(6, 1, 0);
  fs.writeFileSync(headerPath(idf), '#define ESP_IDF_VERSION_MAJOR 6\n');
  const r = readIdfVersion(idf);
  assert.equal(r.ok, false);
  assert.equal(r.version, null);
  assert.equal(r.header, headerPath(idf));
  assert.match(r.problem, /ESP_IDF_VERSION_(MINOR|PATCH)/);
  assert.ok(r.problem.includes(headerPath(idf)));
});

test('readIdfVersion on a nonexistent path returns a problem instead of throwing', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lvglui-none-')), 'nope');
  const r = readIdfVersion(missing);
  assert.equal(r.ok, false);
  assert.equal(r.version, null);
  assert.equal(r.header, null);
  assert.equal(typeof r.problem, 'string');
  assert.ok(r.problem.includes(missing));
});

test('findIdf resolves a relative config.idfPath against the project root', () => {
  const root = makeProject();
  const idf = makeIdfAt(path.join(root, 'esp-idf'), 6, 0, 0);
  const r = findIdf({ root, config: { idfPath: 'esp-idf' }, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'config');
  assert.equal(r.path, path.resolve(idf));
  assert.equal(r.version.major, 6);
});

test('findIdf falls back to env.IDF_PATH when the project has no metadata', () => {
  const root = makeProject();
  const idf = makeIdf(6, 1, 0);
  const r = findIdf({ root, config: {}, env: { IDF_PATH: idf } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
  assert.equal(r.path, path.resolve(idf));
  assert.equal(r.version.major, 6);
});