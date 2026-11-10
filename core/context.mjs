// The single composition seam shared by the CLI, MCP server, render, doctor and
// init: discover a project, read and normalize its config, find ESP-IDF and
// LVGL, resolve the display and derive paths. Read-only; writes nothing and
// never looks for the MSVC toolchain (doctor does that separately, so this
// succeeds on a machine without Visual Studio).

import fs from 'node:fs';
import path from 'node:path';
import { readConfig, normalizeConfig, projectPaths } from './config.mjs';
import { discoverProject } from './discover.mjs';
import { findIdf } from './idf.mjs';
import { findLvgl } from './lvgl.mjs';
import { detectDisplay } from './display.mjs';
import { detectPages } from './pages.mjs';
import { parseSdkconfig } from './kconfig.mjs';
import { readText } from './fsutil.mjs';

// `core/context.mjs` -> the tool checkout root. Never hardcode the checkout
// location: the CLI and the tests run from a copy at an arbitrary path.
const TOOL_DIR = path.resolve(import.meta.dirname, '..');

function emptyIdf(problem = null) {
  return { path: null, version: null, source: null, problem };
}

function emptyLvgl(problem = null) {
  return { dir: null, version: null, source: null, problem };
}

function emptyDisplay(problem = null) {
  return { width: null, height: null, colorDepth: null, source: null, problem };
}

function emptyPaths() {
  return { stateDir: null, buildDir: null, outDir: null, lvConfPath: null };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}

/**
 * Build the shared project context.
 *
 * `ok === false` always carries at least one `problems` entry; callers must not
 * build. `config` is the normalized config (never null, even on failure);
 * `configFile` is null when the project has no `lvglui.json`. A failed stage
 * keeps its field object with null values plus a `problem`.
 *
 * @param {object} [options]
 * @param {string} [options.startDir] directory to start root discovery from
 * @param {string} [options.projectDir] explicit project root (wins over startDir)
 * @param {number} [options.cliWidth] `--width` override
 * @param {number} [options.cliHeight] `--height` override
 * @param {boolean} [options.requireUi] whether a UI directory/entry is required
 * @returns {object} the composed context described above
 */
export function loadContext({
  startDir,
  projectDir,
  cliWidth,
  cliHeight,
  requireUi = true,
} = {}) {
  const start = path.resolve(projectDir ?? startDir ?? process.cwd());
  const discovery = discoverProject(start, { toolRoot: TOOL_DIR, requireUi });
  const root = discovery.root ?? start;

  // Discovery can fail before a root exists (no lvglui.json / CMake project in
  // any ancestor). There is nothing to inspect then: return the discover
  // problems with the derived root and no stage results.
  if (discovery.rootHow === null) {
    return {
      ok: false,
      toolDir: TOOL_DIR,
      root,
      configFile: null,
      config: normalizeConfig(null, root).config,
      uiDir: null,
      entry: null,
      entryHow: null,
      sources: [],
      portInclude: null,
      pages: detectPages([]),
      idf: emptyIdf(),
      lvgl: emptyLvgl(),
      display: emptyDisplay(),
      sdkconfig: null,
      ...emptyPaths(),
      problems: uniqueStrings(discovery.problems),
      warnings: [],
    };
  }

  const problems = [...discovery.problems];
  const warnings = [];

  const cfg = readConfig(root);
  if (cfg.error) problems.push(cfg.error);
  const normalized = normalizeConfig(cfg.data, root);
  problems.push(...normalized.problems);
  const config = normalized.config;

  // ---- ESP-IDF ---------------------------------------------------------
  let idfInfo;
  try {
    idfInfo = findIdf({ root, config, env: process.env });
  } catch (e) {
    idfInfo = { ok: false, problem: `failed to find ESP-IDF: ${e.message}` };
  }
  const idf = idfInfo.ok
    ? { path: idfInfo.path, version: idfInfo.version, source: idfInfo.source, problem: null }
    : emptyIdf(idfInfo.problem);
  if (!idfInfo.ok) problems.push(idfInfo.problem);

  // ---- LVGL ------------------------------------------------------------
  let lvglInfo;
  try {
    lvglInfo = findLvgl({ root, config });
  } catch (e) {
    lvglInfo = { ok: false, problem: `failed to find LVGL: ${e.message}`, warning: null };
  }
  if (lvglInfo.warning) warnings.push(lvglInfo.warning);
  const lvgl = lvglInfo.ok
    ? { dir: lvglInfo.dir, version: lvglInfo.version, source: lvglInfo.source, problem: null }
    : emptyLvgl(lvglInfo.problem);
  if (!lvglInfo.ok) problems.push(lvglInfo.problem);

  // ---- sdkconfig -------------------------------------------------------
  // `<root>/sdkconfig` is firmware evidence, not a required file: a missing one
  // is passed to detectDisplay as an empty map so config/CLI can still win.
  const sdkconfigFile = path.join(root, 'sdkconfig');
  let sdkconfig = null;
  let kconfig = new Map();
  if (fs.existsSync(sdkconfigFile)) {
    sdkconfig = sdkconfigFile;
    try {
      kconfig = parseSdkconfig(sdkconfigFile);
    } catch (e) {
      problems.push(`failed to read ${sdkconfigFile}: ${e.message}`);
    }
  }

  // ---- Display ---------------------------------------------------------
  // Source macros are the last resort; an unreadable UI source is a warning,
  // never a crash, so the rest of the context stays usable.
  const sourceChunks = [];
  for (const file of discovery.sources) {
    try {
      const text = readText(file);
      if (text === null) warnings.push(`UI source not readable: ${file}`);
      else sourceChunks.push(text);
    } catch (e) {
      warnings.push(`UI source not readable: ${file}: ${e.message}`);
    }
  }

  const cli = {};
  if (cliWidth !== undefined) cli.width = cliWidth;
  if (cliHeight !== undefined) cli.height = cliHeight;

  const detected = detectDisplay({
    root,
    config,
    sdkconfig: kconfig,
    cli,
    sourceText: sourceChunks.join('\n'),
  });
  warnings.push(...detected.warnings);
  let display;
  if (detected.ok) {
    display = {
      width: detected.width,
      height: detected.height,
      colorDepth: detected.colorDepth,
      source: detected.source,
      problem: null,
    };
  } else {
    problems.push(detected.problem);
    display = emptyDisplay(detected.problem);
  }

  // ---- Derived paths ---------------------------------------------------
  let paths = emptyPaths();
  try {
    paths = projectPaths(root, config);
  } catch (e) {
    // normalizeConfig normally repairs build.dir; a hand-built config object
    // can still be invalid here. Leave paths null instead of guessing.
    problems.push(e.message);
  }

  // Optional multi-page contract: static scan only (no compile), so a partial
  // contract becomes a precise problem instead of a link error later.
  const pages = detectPages(discovery.sources);
  problems.push(...pages.problems);

  // Optional port include dir: ui_port.h may live in its own component
  // (components/ui_port/include) or in the UI component's own include dir.
  // The host build only compiles uiDir sources, so it needs this path to find
  // the header that the firmware gets through CMake REQUIRES.
  let portInclude = null;
  if (typeof discovery.uiDir === 'string' && discovery.uiDir !== '') {
    const candidates = [
      path.join(path.dirname(discovery.uiDir), 'ui_port', 'include'),
      path.join(root, 'components', 'ui_port', 'include'),
      path.join(discovery.uiDir, 'include'),
    ];
    for (const dir of candidates) {
      try {
        if (fs.statSync(path.join(dir, 'ui_port.h')).isFile()) {
          portInclude = dir;
          break;
        }
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
          warnings.push(`failed to inspect ${dir}: ${e.message}`);
        }
      }
    }
  }

  const mergedProblems = uniqueStrings(problems);
  return {
    ok: mergedProblems.length === 0,
    toolDir: TOOL_DIR,
    root,
    configFile: cfg.file,
    config,
    uiDir: discovery.uiDir,
    entry: discovery.entry,
    entryHow: discovery.entryHow,
    sources: discovery.sources,
    portInclude,
    pages,
    idf,
    lvgl,
    display,
    sdkconfig,
    ...paths,
    problems: mergedProblems,
    warnings: uniqueStrings(warnings),
  };
}