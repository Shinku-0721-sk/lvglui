// ESP-IDF 6.x discovery: find the installation a project points at, verify the
// version header, and report every candidate that was tried. Read-only; never
// invokes idf.py. A stale shell IDF_PATH must lose against project metadata.

import fs from 'node:fs';
import path from 'node:path';
import { readText } from './fsutil.mjs';

const REQUIRED_MAJOR = 6;
const MARKER = path.join('tools', 'idf.py');
const VERSION_HEADER = path.join('components', 'esp_common', 'include', 'esp_idf_version.h');
const VERSION_DEFINE = /^\s*#define\s+ESP_IDF_VERSION_(MAJOR|MINOR|PATCH)\s+(\d+)\b/gm;

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw new Error(`failed to inspect ${p}: ${e.message}`);
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw new Error(`failed to inspect ${p}: ${e.message}`);
  }
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Read the ESP-IDF version from
 * `<idfPath>/components/esp_common/include/esp_idf_version.h`. A missing path,
 * missing header or malformed header returns `{ ok: false }` with an explicit
 * problem instead of throwing.
 */
export function readIdfVersion(idfPath) {
  if (typeof idfPath !== 'string' || idfPath.trim() === '') {
    return { ok: false, version: null, header: null, problem: 'ESP-IDF path is empty' };
  }
  const idfAbs = path.resolve(idfPath);
  if (!isDirectory(idfAbs)) {
    return { ok: false, version: null, header: null, problem: `ESP-IDF path is not a directory: ${idfAbs}` };
  }

  const header = path.join(idfAbs, VERSION_HEADER);
  if (!isFile(header)) {
    return { ok: false, version: null, header: null, problem: `version header missing: ${header}` };
  }

  let text;
  try {
    text = readText(header);
  } catch (e) {
    return { ok: false, version: null, header, problem: e.message };
  }
  if (text === null) {
    return { ok: false, version: null, header, problem: `version header not readable: ${header}` };
  }

  const found = {};
  VERSION_DEFINE.lastIndex = 0;
  for (const match of text.matchAll(VERSION_DEFINE)) {
    found[match[1]] = Number.parseInt(match[2], 10);
  }
  const missing = ['MAJOR', 'MINOR', 'PATCH'].filter((part) => found[part] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      version: null,
      header,
      problem: `version header is malformed, missing ${missing.map((p) => `ESP_IDF_VERSION_${p}`).join(', ')}: ${header}`,
    };
  }

  const version = { major: found.MAJOR, minor: found.MINOR, patch: found.PATCH };
  return { ok: true, version, header, problem: null };
}

/**
 * Remove line and block comments from JSONC while preserving string values
 * verbatim, so Windows paths and URLs that contain comment-like text are not
 * mistaken for comments.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          out += next;
          i += 1;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Read a JSON (or JSONC) metadata file. Missing, unreadable, malformed or
 * non-object files are recorded in `attempts` and return null so discovery can
 * continue with the next candidate.
 */
function readMetadata(file, label, attempts, { jsonc = false } = {}) {
  if (!isFile(file)) {
    attempts.push({ label, path: file, reason: 'file not found' });
    return null;
  }

  let text;
  try {
    text = readText(file);
  } catch (e) {
    attempts.push({ label, path: file, reason: e.message });
    return null;
  }
  if (text === null) {
    attempts.push({ label, path: file, reason: 'file not readable' });
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (jsonc) text = stripJsonComments(text);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    attempts.push({ label, path: file, reason: `invalid JSON: ${e.message}` });
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    attempts.push({ label, path: file, reason: 'expected a JSON object' });
    return null;
  }
  return parsed;
}

function candidatePath(root, value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return path.resolve(root, value);
}

function checkoutProblem(dir) {
  if (!isDirectory(dir)) return 'directory not found';
  if (!isFile(path.join(dir, MARKER))) return 'missing tools/idf.py';
  return null;
}

/**
 * Find the ESP-IDF installation for a project. Candidates are tried in this
 * order: `config.idfPath`, `<root>/build/project_description.json#idf_path`,
 * `<root>/.vscode/settings.json#idf.currentSetup`, then `env.IDF_PATH`.
 *
 * A candidate without `tools/idf.py` is skipped and recorded. A candidate that
 * has the marker but a wrong/missing version is a hard failure: the project
 * explicitly selected that installation, so a later candidate must not hide
 * the problem.
 */
export function findIdf(options = {}) {
  const { root, config, env = process.env } = options;
  const rootAbs = path.resolve(root ?? '.');
  const data = config !== null && typeof config === 'object' ? config : {};
  const attempts = [];

  function attempt(source, label, dir) {
    const abs = path.resolve(dir);
    const problem = checkoutProblem(abs);
    if (problem) {
      attempts.push({ label, path: abs, reason: problem });
      return null;
    }

    const info = readIdfVersion(abs);
    if (!info.ok || info.version === null) {
      return { ok: false, path: abs, version: null, source, problem: info.problem };
    }
    if (info.version.major !== REQUIRED_MAJOR) {
      return {
        ok: false,
        path: abs,
        version: info.version,
        source,
        problem: `需要 ESP-IDF 6.x，发现 ${formatVersion(info.version)} (${abs})`,
      };
    }
    return { ok: true, path: abs, version: info.version, source, problem: null };
  }

  // 1. lvglui.json's idfPath (relative paths resolve against the project root).
  const configured = candidatePath(rootAbs, data.idfPath);
  if (configured === null) {
    attempts.push({ label: 'config.idfPath', path: null, reason: 'not configured' });
  } else {
    const result = attempt('config', 'config.idfPath', configured);
    if (result) return result;
  }

  // 2. build/project_description.json, written by the project's last configure.
  const descriptionFile = path.join(rootAbs, 'build', 'project_description.json');
  const description = readMetadata(descriptionFile, 'build/project_description.json', attempts);
  if (description !== null) {
    const idfValue = description.idf_path;
    if (typeof idfValue !== 'string' || idfValue.trim() === '') {
      attempts.push({ label: 'build/project_description.json', path: descriptionFile, reason: 'no idf_path' });
    } else {
      const result = attempt('project-description', 'build/project_description.json', path.resolve(rootAbs, idfValue));
      if (result) return result;
    }
  }

  // 3. VS Code ESP-IDF extension settings (JSONC).
  const settingsFile = path.join(rootAbs, '.vscode', 'settings.json');
  const settings = readMetadata(settingsFile, '.vscode/settings.json', attempts, { jsonc: true });
  if (settings !== null) {
    // VS Code settings use a flat, dotted key rather than a nested object.
    const idfValue = settings['idf.currentSetup'];
    if (typeof idfValue !== 'string' || idfValue.trim() === '') {
      attempts.push({ label: '.vscode/settings.json', path: settingsFile, reason: 'no idf.currentSetup' });
    } else {
      const result = attempt('vscode', '.vscode/settings.json', path.resolve(rootAbs, idfValue));
      if (result) return result;
    }
  }

  // 4. The shell environment is the last resort; it may be stale.
  const fromEnv = candidatePath(rootAbs, env?.IDF_PATH);
  if (fromEnv === null) {
    attempts.push({ label: 'IDF_PATH', path: null, reason: 'not set' });
  } else {
    const result = attempt('env', 'IDF_PATH', fromEnv);
    if (result) return result;
  }

  const lines = attempts.map((entry) => {
    const where = entry.path === null ? '' : ` "${entry.path}"`;
    return `- ${entry.label}${where}: ${entry.reason}`;
  });
  return {
    ok: false,
    path: null,
    version: null,
    source: null,
    problem: `未找到可用的 ESP-IDF 6.x，已尝试:\n${lines.join('\n')}`,
  };
}