// Locate the Windows C++ toolchain used to build the host viewer/screenshot
// binaries: MSVC vcvars64.bat, cmake.exe and ninja.exe.
//
// Per item the order is explicit config -> environment -> auto discovery.
// An explicitly configured path that does not exist is reported as a problem
// and is never silently replaced by a fallback; auto candidates that do not
// exist are skipped. `exists` and `run` can be injected for tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ITEMS = ['vcvars', 'cmake', 'ninja'];

const ENV_KEYS = {
  vcvars: 'LVGLUI_VCVARS',
  cmake: 'LVGLUI_CMAKE',
  ninja: 'LVGLUI_NINJA',
};

const VSWHERE_ARGS = [
  '-latest',
  '-products',
  '*',
  '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property',
  'installationPath',
];

const HINTS = {
  vcvars: 'set build.vcvars or LVGLUI_VCVARS, or install the Visual Studio C++ build tools',
  cmake: 'set build.cmake or LVGLUI_CMAKE, put cmake.exe on PATH, or install the ESP-IDF tools',
  ninja: 'set build.ninja or LVGLUI_NINJA, put ninja.exe on PATH, or install the ESP-IDF tools',
};

function defaultRun(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbsolutePath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
}

// Explicit relative paths are relative to the project root; absolute paths are
// kept byte-for-byte so callers can pass forward-slash Windows paths.
function resolveAgainst(root, value) {
  return isAbsolutePath(value) ? value : path.resolve(root, value);
}

function safeExists(exists, target) {
  try {
    return Boolean(exists(target));
  } catch {
    return false;
  }
}

function safeRun(run, cmd, args) {
  try {
    return run(cmd, args) || null;
  } catch (e) {
    return { status: null, stdout: '', stderr: '', error: e };
  }
}

function runSucceeded(result) {
  if (!result || result.error) return false;
  return result.status === 0 || result.status === undefined;
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

function compareVersionsDesc(a, b) {
  const left = String(a).split(/[._-]/);
  const right = String(b).split(/[._-]/);
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i += 1) {
    const l = left[i] ?? '0';
    const r = right[i] ?? '0';
    const ln = Number(l);
    const rn = Number(r);
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return rn - ln;
    } else {
      const order = r.localeCompare(l);
      if (order !== 0) return order;
    }
  }
  return 0;
}

function idfToolsRoots(root, env) {
  const roots = [];
  const push = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const resolved = resolveAgainst(root, value.trim());
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  push(env?.IDF_TOOLS_PATH);
  push('E:/Espressif/tools');
  const home = env?.USERPROFILE || env?.HOME || os.homedir();
  if (home) push(path.join(home, '.espressif', 'tools'));
  return roots;
}

function findVcvarsAuto(env, exists, run) {
  const vcInstall = typeof env?.VCINSTALLDIR === 'string' ? env.VCINSTALLDIR.trim() : '';
  if (vcInstall) {
    const candidate = path.join(vcInstall, 'Auxiliary', 'Build', 'vcvars64.bat');
    if (safeExists(exists, candidate)) return { path: candidate, source: 'vcinstall' };
  }

  // Prefer the x86 Program Files view, but fall back to ProgramFiles when that
  // view exists yet has no vswhere.exe installed.
  const programFilesCandidates = [];
  for (const value of [env?.['ProgramFiles(x86)'], env?.ProgramFiles]) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const resolved = value.trim();
    if (!programFilesCandidates.includes(resolved)) programFilesCandidates.push(resolved);
  }

  for (const programFiles of programFilesCandidates) {
    const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!safeExists(exists, vswhere)) continue;

    const result = safeRun(run, vswhere, VSWHERE_ARGS);
    if (!runSucceeded(result)) continue;
    const installation = firstLine(result.stdout);
    if (!installation) continue;

    const candidate = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    if (safeExists(exists, candidate)) return { path: candidate, source: 'vswhere' };
  }
  return null;
}

function findOnPath(name, exists, run) {
  const result = safeRun(run, 'where.exe', [name]);
  if (!runSucceeded(result)) return null;
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate && safeExists(exists, candidate)) return candidate;
  }
  return null;
}

// `<toolsRoot>/cmake/<version>/bin/cmake.exe` or `<toolsRoot>/ninja/<version>/ninja.exe`,
// newest version first. Unreadable roots are skipped.
function findInIdfTools(name, roots, exists) {
  const tail = name === 'cmake' ? ['bin', 'cmake.exe'] : ['ninja.exe'];
  for (const toolsRoot of roots) {
    const base = path.join(toolsRoot, name);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionsDesc);
    for (const version of versions) {
      const candidate = path.join(base, version, ...tail);
      if (safeExists(exists, candidate)) return candidate;
    }
  }
  return null;
}

function findAuto(item, { root, env, exists, run }) {
  if (item === 'vcvars') return findVcvarsAuto(env, exists, run);
  const onPath = findOnPath(item, exists, run);
  if (onPath) return { path: onPath, source: 'path' };
  const fromIdf = findInIdfTools(item, idfToolsRoots(root, env), exists);
  return fromIdf ? { path: fromIdf, source: 'idf-tools' } : null;
}

/**
 * Discover vcvars64.bat, cmake.exe and ninja.exe.
 *
 * @param {object} options
 * @param {string} options.root project root used for relative paths
 * @param {object} [options.config] normalized lvglui.json (uses `config.build`)
 * @param {object} [options.idf] accepted for call-site symmetry
 * @param {object} [options.env] usually `process.env`
 * @param {(file: string) => boolean} [options.exists]
 * @param {(cmd: string, args: string[]) => object} [options.run] spawnSync-shaped
 * @returns {{ok: boolean, vcvars: string|null, cmake: string|null, ninja: string|null,
 *   source: 'config'|'env'|'vswhere'|'vcinstall'|'path'|'idf-tools'|'mixed',
 *   problems: string[]}}
 */
export function findToolchain(options = {}) {
  const root = path.resolve(options.root ?? '.');
  const config = isPlainObject(options.config) ? options.config : {};
  const build = isPlainObject(config.build) ? config.build : {};
  const env = isPlainObject(options.env) ? options.env : {};
  const exists = typeof options.exists === 'function' ? options.exists : fs.existsSync;
  const run = typeof options.run === 'function' ? options.run : defaultRun;

  const found = { vcvars: null, cmake: null, ninja: null };
  const origins = { vcvars: null, cmake: null, ninja: null };
  const problems = [];
  const blocked = new Set();

  try {
    // 1. explicit config
    for (const item of ITEMS) {
      const value = typeof build[item] === 'string' ? build[item].trim() : '';
      if (!value) continue;
      const resolved = resolveAgainst(root, value);
      if (safeExists(exists, resolved)) {
        found[item] = resolved;
        origins[item] = 'config';
      } else {
        blocked.add(item);
        problems.push(`${item}: configured path ${JSON.stringify(resolved)} does not exist (explicit paths are never replaced by discovery)`);
      }
    }

    // 2. environment
    for (const item of ITEMS) {
      if (found[item] || blocked.has(item)) continue;
      const envValue = typeof env[ENV_KEYS[item]] === 'string' ? env[ENV_KEYS[item]].trim() : '';
      if (!envValue) continue;
      const resolved = resolveAgainst(root, envValue);
      if (safeExists(exists, resolved)) {
        found[item] = resolved;
        origins[item] = 'env';
      } else {
        blocked.add(item);
        problems.push(`${item}: ${ENV_KEYS[item]} points to ${JSON.stringify(resolved)}, which does not exist`);
      }
    }

    // 3. auto discovery
    for (const item of ITEMS) {
      if (found[item] || blocked.has(item)) continue;
      const auto = findAuto(item, { root, env, exists, run });
      if (auto) {
        found[item] = auto.path;
        origins[item] = auto.source;
      } else {
        problems.push(`${item}: not found (${HINTS[item]})`);
      }
    }
  } catch (e) {
    problems.push(`toolchain discovery failed: ${e.message}`);
  }

  const allFound = ITEMS.every((item) => found[item] !== null);
  const distinct = new Set(ITEMS.map((item) => origins[item]));
  const source = allFound && distinct.size === 1 ? origins.vcvars : 'mixed';

  return {
    ok: problems.length === 0 && allFound,
    vcvars: found.vcvars,
    cmake: found.cmake,
    ninja: found.ninja,
    source,
    problems,
  };
}