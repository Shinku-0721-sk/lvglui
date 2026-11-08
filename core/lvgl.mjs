// LVGL 9.x discovery: find the LVGL source tree a project uses, verify its
// version header, and report every candidate that was tried. Read-only,
// never builds and never touches the target project.

import fs from 'node:fs';
import path from 'node:path';
import { readText } from './fsutil.mjs';

const REQUIRED_MAJOR = 9;
const MIN_MINOR = 0;
const MAX_MINOR = 99;
const SEARCH_MAX_DEPTH = 4;
const SEARCH_SKIP_DIRS = new Set(['.git', 'build', 'node_modules']);
const PUBLIC_HEADERS = [path.join('lvgl.h'), path.join('include', 'lvgl', 'lvgl.h')];
const VERSION_HEADERS = [
  path.join('lv_version.h'),
  path.join('src', 'lv_version.h'),
  path.join('include', 'lvgl', 'lv_version.h'),
];
const VERSION_DEFINE = /^\s*#define\s+LVGL_VERSION_(MAJOR|MINOR|PATCH)\s+(\d+)\b/gm;

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

function versionProblem(version, header) {
  if (version.major !== REQUIRED_MAJOR) {
    return `需要 LVGL 9.x，发现 ${formatVersion(version)} (${header})`;
  }
  if (!Number.isInteger(version.minor) || version.minor < MIN_MINOR || version.minor > MAX_MINOR) {
    return `LVGL version ${formatVersion(version)} has invalid minor ${version.minor}; expected ${MIN_MINOR}..${MAX_MINOR} (${header})`;
  }
  if (!Number.isInteger(version.patch)) {
    return `LVGL version ${formatVersion(version)} has invalid patch ${version.patch} (${header})`;
  }
  return null;
}

function parseVersionDefines(text) {
  const found = {};
  VERSION_DEFINE.lastIndex = 0;
  for (const match of text.matchAll(VERSION_DEFINE)) {
    found[match[1]] = Number.parseInt(match[2], 10);
  }
  return found;
}

/**
 * Read the LVGL version from the first usable version header below `lvglDir`.
 * Candidates are tried in compatibility order: `<dir>/lv_version.h`,
 * `<dir>/src/lv_version.h`, `<dir>/include/lvgl/lv_version.h`. A deprecated
 * shim header without defines is skipped rather than reported as malformed, so
 * the real 9.x version header underneath it still wins.
 */
export function readLvglVersion(lvglDir) {
  if (typeof lvglDir !== 'string' || lvglDir.trim() === '') {
    return { ok: false, version: null, header: null, problem: 'LVGL path is empty' };
  }
  const dirAbs = path.resolve(lvglDir);
  let dirExists;
  try {
    dirExists = isDirectory(dirAbs);
  } catch (e) {
    return { ok: false, version: null, header: null, problem: e.message };
  }
  if (!dirExists) {
    return { ok: false, version: null, header: null, problem: `LVGL path is not a directory: ${dirAbs}` };
  }

  const tried = [];
  for (const rel of VERSION_HEADERS) {
    const header = path.join(dirAbs, rel);
    let headerExists;
    try {
      headerExists = isFile(header);
    } catch (e) {
      tried.push(`- ${header}: ${e.message}`);
      continue;
    }
    if (!headerExists) {
      tried.push(`- ${header}: missing`);
      continue;
    }

    let text;
    try {
      text = readText(header);
    } catch (e) {
      tried.push(`- ${header}: ${e.message}`);
      continue;
    }
    if (text === null) {
      tried.push(`- ${header}: not readable`);
      continue;
    }

    const found = parseVersionDefines(text);
    const missing = ['MAJOR', 'MINOR', 'PATCH'].filter((part) => found[part] === undefined);
    if (missing.length > 0) {
      tried.push(`- ${header}: missing ${missing.map((part) => `LVGL_VERSION_${part}`).join(', ')}`);
      continue;
    }

    const version = { major: found.MAJOR, minor: found.MINOR, patch: found.PATCH };
    const problem = versionProblem(version, header);
    if (problem) return { ok: false, version, header, problem };
    return { ok: true, version, header, problem: null };
  }

  return {
    ok: false,
    version: null,
    header: null,
    problem: `no usable LVGL version header under ${dirAbs}; tried:\n${tried.join('\n')}`,
  };
}

function inspectCandidate(dir) {
  const abs = path.resolve(dir);
  if (!isDirectory(abs)) {
    return { dir: abs, problem: 'directory not found' };
  }

  const headers = PUBLIC_HEADERS.map((rel) => path.join(abs, rel)).filter((file) => isFile(file));
  if (headers.length === 0) {
    const looked = PUBLIC_HEADERS.map((rel) => path.join(abs, rel)).join(', ');
    return { dir: abs, problem: `missing public header; looked for ${looked}` };
  }

  if (!isDirectory(path.join(abs, 'src'))) {
    const warning = `skipped ${abs}: lvgl.h found but src/ is missing`;
    return { dir: abs, problem: 'lvgl.h found but src/ is missing', warning };
  }

  let info;
  try {
    info = readLvglVersion(abs);
  } catch (e) {
    return { dir: abs, problem: e.message };
  }
  if (!info.ok) {
    const result = { dir: abs, version: info.version ?? null, problem: info.problem };
    // A parsed but unsupported version (8.x, bad minor) is a skipped candidate,
    // not a silently missing one: a later 9.x tree must not hide it.
    if (info.version) result.warning = `skipped ${abs}: ${info.problem}`;
    return result;
  }
  return { dir: abs, version: info.version, header: info.header, ok: true };
}

function sortedDirectories(entries) {
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !entry.name.startsWith('.') && !SEARCH_SKIP_DIRS.has(entry.name.toLowerCase()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Find the LVGL source tree for a project. Candidates are tried in this order:
 * `config.lvglDir` (relative paths resolve against `root`),
 * `<root>/managed_components/lvgl__lvgl`, `<root>/components/lvgl`, then a
 * sorted walk of `root` to depth 4.
 *
 * An explicit `config.lvglDir` is a user assertion: an invalid one fails
 * immediately instead of falling through to a managed component. Other
 * candidates are skipped with their reason recorded; a candidate with
 * `lvgl.h` but no `src/` additionally produces a non-fatal `warning`.
 */
export function findLvgl(options = {}) {
  const { root, config } = options;
  const rootAbs = path.resolve(root ?? '.');
  const data = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const attempts = [];
  const warnings = [];
  const tried = new Set();

  function success(result, source) {
    return {
      ok: true,
      dir: result.dir,
      version: result.version,
      source,
      warning: warnings.length > 0 ? warnings.join('; ') : null,
      problem: null,
    };
  }

  function failure(problem, extra = {}) {
    return {
      ok: false,
      dir: null,
      version: null,
      source: null,
      warning: warnings.length > 0 ? warnings.join('; ') : null,
      problem,
      ...extra,
    };
  }

  function attempt(source, label, dir) {
    let result;
    try {
      result = inspectCandidate(dir);
    } catch (e) {
      attempts.push({ label, path: path.resolve(dir), reason: e.message });
      return null;
    }
    if (result.ok) return success(result, source);
    attempts.push({ label, path: result.dir, reason: result.problem });
    if (result.warning) warnings.push(result.warning);
    return null;
  }

  // 1. lvglui.json's lvglDir: explicit and therefore authoritative.
  let configured = null;
  if (Object.prototype.hasOwnProperty.call(data, 'lvglDir')) {
    const raw = data.lvglDir;
    if (typeof raw !== 'string') {
      return failure(
        `config.lvglDir must be a non-empty string, got ${JSON.stringify(raw)}; omit it or use "" to mean unconfigured`,
      );
    }
    if (raw.trim() !== '') configured = path.resolve(rootAbs, raw);
  }
  if (configured === null) {
    attempts.push({ label: 'config.lvglDir', path: null, reason: 'not configured' });
  } else {
    let result;
    try {
      result = inspectCandidate(configured);
    } catch (e) {
      return failure(
        `config.lvglDir is not a usable LVGL 9.x source tree: "${data.lvglDir}" (${configured}): ${e.message}`,
      );
    }
    if (result.ok) return success(result, 'config');
    if (result.warning) warnings.push(result.warning);
    return failure(
      `config.lvglDir is not a usable LVGL 9.x source tree: "${data.lvglDir}" (${configured}): ${result.problem}`,
      { version: result.version ?? null },
    );
  }

  // 2. ESP-IDF managed component.
  const managed = path.join(rootAbs, 'managed_components', 'lvgl__lvgl');
  tried.add(managed);
  const managedResult = attempt('managed', 'managed_components/lvgl__lvgl', managed);
  if (managedResult) return managedResult;

  // 3. Conventional component location; reported as `search` because the
  // public result shape only names config, managed and search.
  const component = path.join(rootAbs, 'components', 'lvgl');
  tried.add(component);
  const componentResult = attempt('search', 'components/lvgl', component);
  if (componentResult) return componentResult;

  // 4. Bounded, sorted walk. Directory symlinks are never followed.
  let searchedCandidate = false;

  function visit(current, depth) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      attempts.push({ label: 'search', path: current, reason: `failed to scan: ${e.message}` });
      return null;
    }

    for (const entry of sortedDirectories(entries)) {
      const childDepth = depth + 1;
      if (childDepth > SEARCH_MAX_DEPTH) continue;
      const full = path.join(current, entry.name);
      if (tried.has(full)) continue;

      let looksLikeLvgl;
      try {
        looksLikeLvgl = PUBLIC_HEADERS.some((rel) => isFile(path.join(full, rel)));
      } catch (e) {
        attempts.push({ label: 'search', path: full, reason: e.message });
        continue;
      }
      if (looksLikeLvgl) {
        tried.add(full);
        searchedCandidate = true;
        const result = attempt('search', 'search', full);
        if (result) return result;
        // Never descend into a directory already treated as an LVGL tree.
        continue;
      }

      if (childDepth < SEARCH_MAX_DEPTH) {
        const nested = visit(full, childDepth);
        if (nested) return nested;
      }
    }
    return null;
  }

  const searched = visit(rootAbs, 0);
  if (searched) return searched;
  if (!searchedCandidate) {
    attempts.push({
      label: 'search',
      path: rootAbs,
      reason: `no directory containing lvgl.h within depth ${SEARCH_MAX_DEPTH} (skipped .git, build, node_modules and symlinks)`,
    });
  }

  const lines = attempts.map((entry) => {
    const where = entry.path === null ? '' : ` "${entry.path}"`;
    return `- ${entry.label}${where}: ${entry.reason}`;
  });
  return failure(`未找到可用的 LVGL 9.x，已尝试:\n${lines.join('\n')}`);
}
