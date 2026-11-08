// Project discovery: find the ESP-IDF project root, the UI directory, the UI
// entry function and the UI source list. Read-only; paths stay inside the root.

import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { readText } from './fsutil.mjs';

const COMMON_UI_DIRS = ['components/app_ui', 'components/ui', 'ui', 'main/ui'];
const SKIP_DIRS = new Set(['build', 'node_modules', 'managed_components', 'test']);

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw new Error(`failed to inspect ${p}: ${e.message}`);
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isSkippedDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
}

function isCmakeRoot(dir) {
  const cmake = path.join(dir, 'CMakeLists.txt');
  if (!fs.existsSync(cmake)) return false;
  const text = readText(cmake);
  if (text === null || !/\bproject\s*\(/.test(text)) return false;
  return fs.existsSync(path.join(dir, 'sdkconfig')) || isDirectory(path.join(dir, 'main'));
}

/**
 * Walk up from `startDir` to find a project root. A directory containing
 * `lvglui.json` is a root; otherwise a CMakeLists.txt with `project(...)` plus
 * `sdkconfig` or `main/` marks one. `skipDir` (usually the tool checkout) and
 * its descendants are never treated as roots. Stops at the volume root.
 */
export function findProjectRoot(startDir, { skipDir } = {}) {
  const skip = skipDir ? path.resolve(skipDir) : null;
  let dir = path.resolve(startDir);
  for (;;) {
    if (!skip || !isInside(skip, dir)) {
      if (fs.existsSync(path.join(dir, 'lvglui.json'))) return { root: dir, how: 'config' };
      if (isCmakeRoot(dir)) return { root: dir, how: 'cmake' };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Collect source files below `dir` with the requested extensions. Returns
 * absolute paths sorted lexicographically. Hidden, build, dependency and test
 * directories are skipped; recursion stops after `maxDepth` levels.
 */
export function walkSources(dir, { maxDepth = 6, exts = ['.c'] } = {}) {
  const root = path.resolve(dir);
  const wanted = new Set(exts.map((ext) => ext.toLowerCase()));
  const out = [];

  function visit(current, depth) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      throw new Error(`failed to scan ${current}: ${e.message}`);
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth || isSkippedDir(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile() && wanted.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  visit(root, 0);
  out.sort();
  return out;
}

function hasUiSources(dir) {
  if (!isDirectory(dir)) return false;
  return walkSources(dir).length > 0;
}

function collectCallSites(files) {
  const sites = [];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const re = /lv_(?:screen|scr)_load\s*\(\s*([A-Za-z_]\w*)\s*\(/g;
    let match;
    while ((match = re.exec(text)) !== null) sites.push({ name: match[1], file });
  }
  return sites;
}

function collectDefinitions(files) {
  const definitions = [];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const re = /lv_obj_t\s*\*\s*([A-Za-z_]\w*)\s*\(\s*(?:lv_obj_t\s*\*\s*\w*|void)\s*\)/g;
    let match;
    while ((match = re.exec(text)) !== null) definitions.push({ name: match[1], file });
  }
  return definitions;
}

function emptyResult(root, problems) {
  return {
    ok: false,
    root,
    rootHow: null,
    configFile: null,
    uiDir: null,
    uiDirHow: null,
    entry: null,
    entryHow: null,
    sources: [],
    problems,
  };
}

/**
 * Discover everything a later stage needs to build the project.
 *
 * `requireUi` controls whether a missing UI directory/entry is an error: it is
 * true for render/build commands and false for `init`, which creates the UI.
 *
 * @returns {{ok:boolean, root:string, rootHow:'config'|'cmake'|null,
 *   configFile:string|null, uiDir:string|null, uiDirHow:'config'|'common-dir'|null,
 *   entry:string|null, entryHow:'config'|'call-site'|'definition'|null,
 *   sources:string[], problems:string[]}}
 */
export function discoverProject(startDir, { toolRoot, requireUi = true } = {}) {
  const start = path.resolve(startDir);
  const problems = [];

  let hit;
  try {
    hit = findProjectRoot(start, { skipDir: toolRoot });
  } catch (e) {
    return emptyResult(start, [e.message]);
  }
  if (!hit) {
    const skipped = toolRoot ? ` (skipped tool root ${path.resolve(toolRoot)})` : '';
    return emptyResult(start, [
      `no ESP-IDF project root found above ${start}${skipped}; looked for lvglui.json, or CMakeLists.txt with project() plus sdkconfig or main/`,
    ]);
  }

  const root = hit.root;
  const cfg = readConfig(root);
  const configFile = cfg.file;
  if (cfg.error) problems.push(cfg.error);

  let conf = cfg.data;
  if (conf !== null && (typeof conf !== 'object' || Array.isArray(conf))) {
    problems.push(`${configFile} must contain a JSON object, got ${JSON.stringify(conf)}`);
    conf = null;
  }
  conf = conf || {};

  // ---- UI directory: config first, then conventional locations ----------
  let uiDir = null;
  let uiDirHow = null;
  const configuredUiDir = typeof conf.uiDir === 'string' ? conf.uiDir : '';

  if (configuredUiDir !== '') {
    const resolved = path.resolve(root, configuredUiDir);
    if (!isInside(root, resolved)) {
      problems.push(`uiDir must stay inside project: "${configuredUiDir}"`);
    } else if (!isDirectory(resolved)) {
      problems.push(`uiDir does not exist or is not a directory: "${configuredUiDir}" (${resolved})`);
    } else {
      uiDir = resolved;
      uiDirHow = 'config';
    }
  }

  if (!uiDir) {
    for (const rel of COMMON_UI_DIRS) {
      const candidate = path.join(root, rel);
      let found;
      try {
        found = hasUiSources(candidate);
      } catch (e) {
        problems.push(e.message);
        continue;
      }
      if (found) {
        uiDir = candidate;
        uiDirHow = 'common-dir';
        break;
      }
    }
  }

  if (!uiDir && requireUi) {
    problems.push(`no UI source directory found under ${root} (tried ${COMMON_UI_DIRS.join(', ')})`);
  }

  // ---- Sources ----------------------------------------------------------
  let sources = [];
  if (uiDir) {
    try {
      sources = walkSources(uiDir);
    } catch (e) {
      problems.push(e.message);
    }
  }

  // ---- Entry function: config first, then call sites, then definitions ---
  // Call sites commonly live outside the UI component (for example
  // main/app_ui.c), so entry detection scans the whole project root.
  let projectSources = sources;
  try {
    projectSources = walkSources(root);
  } catch (e) {
    problems.push(e.message);
  }

  let entry = null;
  let entryHow = null;
  const configuredEntry = typeof conf.entry === 'string' ? conf.entry : '';
  if (configuredEntry !== '') {
    entry = configuredEntry;
    entryHow = 'config';
  }

  if (!entry) {
    try {
      // A UI entry is normally defined in the UI component. Prefer a call
      // site whose target exists there, then the firmware entry under main/,
      // then the first call site in stable sorted order.
      const uiDirDefinitions = collectDefinitions(sources);
      const uiDirNames = new Set(uiDirDefinitions.map((definition) => definition.name));
      const callSites = collectCallSites(projectSources);
      const mainDir = path.join(root, 'main');
      const pick =
        callSites.find((site) => uiDirNames.has(site.name)) ||
        callSites.find((site) => isInside(mainDir, site.file)) ||
        callSites[0];

      if (pick) {
        entry = pick.name;
        entryHow = 'call-site';
      } else {
        // No call site: prefer a definition in the UI component before
        // falling back to the whole project.
        const definition = uiDirDefinitions[0] || collectDefinitions(projectSources)[0];
        if (definition) {
          entry = definition.name;
          entryHow = 'definition';
        }
      }
    } catch (e) {
      problems.push(e.message);
    }
  }

  if (!entry && requireUi) {
    const where = uiDir ? `in ${uiDir}` : `under ${root}`;
    problems.push(`no UI entry function found ${where}; looked for lvglui.json entry, lv_screen_load(xxx_create()), and lv_obj_t *xxx_create(lv_obj_t *))`);
  }

  return {
    ok: problems.length === 0,
    root,
    rootHow: hit.how,
    configFile,
    uiDir,
    uiDirHow,
    entry,
    entryHow,
    sources,
    problems,
  };
}