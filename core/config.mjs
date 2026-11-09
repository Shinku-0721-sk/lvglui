// lvglui.json model: read, validate/normalize, write, and derive project paths.

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = 'lvglui.json';

// Bounds shared with `init` so it cannot write a config that normalization
// would immediately reject.
export const DISPLAY_MIN = 16;
export const DISPLAY_MAX = 2048;

const DEFAULTS = {
  schema: 1,
  idfPath: '',
  lvglDir: '',
  uiDir: '',
  entry: '',
  display: null,
  build: { dir: '.lvglui/build', cmake: '', ninja: '', vcvars: '' },
  font: { mode: 'off', dynamic: 'labels', file: '', size: 16, name: '', cjk: false },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultConfig() {
  return {
    ...DEFAULTS,
    build: { ...DEFAULTS.build },
    font: { ...DEFAULTS.font },
  };
}

function stringField(value, fallback, name, problems) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    problems.push(`${name} must be a string, got ${JSON.stringify(value)}`);
    return fallback;
  }
  return value;
}

// Returns null when `value` is a relative path that stays inside `root`, or a
// short reason string explaining why it is not allowed.
function relativePathProblem(root, value) {
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]{2}/.test(value)) {
    return 'absolute paths are not allowed';
  }
  if (value.split(/[\\/]+/).includes('..')) return '".." segments are not allowed';
  const rel = path.relative(root, path.resolve(root, value));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return 'path escapes the project root';
  }
  return null;
}

/**
 * Read `<root>/lvglui.json`.
 * A missing file is not an error: `{ file: null, data: null, error: null }`.
 */
export function readConfig(root) {
  const file = path.join(path.resolve(root), CONFIG_FILE);
  if (!fs.existsSync(file)) return { file: null, data: null, error: null };
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { file, data: JSON.parse(text), error: null };
  } catch (e) {
    return { file, data: null, error: `failed to read ${file}: ${e.message}` };
  }
}

/**
 * Validate `data` and fill defaults. Unknown fields are preserved for forward
 * compatibility but are not validated. Problems are collected instead of
 * throwing, and every problem names the offending field and value.
 */
export function normalizeConfig(data, root) {
  if (data === undefined || data === null) data = {};
  if (!isPlainObject(data)) {
    return {
      ok: false,
      config: defaultConfig(),
      problems: [`${CONFIG_FILE} must contain a JSON object, got ${JSON.stringify(data)}`],
    };
  }

  const rootAbs = path.resolve(root);
  const problems = [];
  const config = { ...data };

  if (data.schema === undefined) config.schema = 1;
  else if (data.schema !== 1) {
    config.schema = 1;
    problems.push(`schema must be 1, got ${JSON.stringify(data.schema)}`);
  }

  config.idfPath = stringField(data.idfPath, '', 'idfPath', problems);
  config.lvglDir = stringField(data.lvglDir, '', 'lvglDir', problems);

  config.uiDir = stringField(data.uiDir, '', 'uiDir', problems);
  if (config.uiDir !== '') {
    const why = relativePathProblem(rootAbs, config.uiDir);
    if (why) {
      problems.push(`uiDir must stay inside project: "${config.uiDir}" (${why})`);
      config.uiDir = '';
    }
  }

  config.entry = stringField(data.entry, '', 'entry', problems);
  if (config.entry !== '' && !/^[A-Za-z_]\w*$/.test(config.entry)) {
    problems.push(`entry must be a C identifier, got "${config.entry}"`);
  }

  config.display = null;
  if (data.display !== undefined && data.display !== null) {
    if (!isPlainObject(data.display)) {
      problems.push(`display must be an object with width, height and colorDepth, got ${JSON.stringify(data.display)}`);
    } else {
      const before = problems.length;
      const { width, height, colorDepth } = data.display;
      if (!Number.isInteger(width) || width < DISPLAY_MIN || width > DISPLAY_MAX) {
        problems.push(`display.width must be an integer between ${DISPLAY_MIN} and ${DISPLAY_MAX}, got ${JSON.stringify(width)}`);
      }
      if (!Number.isInteger(height) || height < DISPLAY_MIN || height > DISPLAY_MAX) {
        problems.push(`display.height must be an integer between ${DISPLAY_MIN} and ${DISPLAY_MAX}, got ${JSON.stringify(height)}`);
      }
      if (colorDepth !== 16) {
        problems.push(`display.colorDepth must be 16, got ${JSON.stringify(colorDepth)}`);
      }
      if (problems.length === before) {
        config.display = { ...data.display, width, height, colorDepth };
      }
    }
  }

  if (data.build !== undefined && !isPlainObject(data.build)) {
    problems.push(`build must be an object, got ${JSON.stringify(data.build)}`);
    config.build = { ...DEFAULTS.build };
  } else {
    const build = { ...DEFAULTS.build, ...(data.build || {}) };
    for (const key of ['cmake', 'ninja', 'vcvars']) {
      build[key] = stringField(build[key], '', `build.${key}`, problems);
    }
    build.dir = stringField(build.dir, DEFAULTS.build.dir, 'build.dir', problems);
    if (build.dir === '') {
      problems.push('build.dir must not be empty');
      build.dir = DEFAULTS.build.dir;
    } else {
      const why = relativePathProblem(rootAbs, build.dir);
      if (why) {
        problems.push(`build.dir must stay inside project: "${build.dir}" (${why})`);
        build.dir = DEFAULTS.build.dir;
      }
    }
    config.build = build;
  }

  if (data.font !== undefined && !isPlainObject(data.font)) {
    problems.push(`font must be an object, got ${JSON.stringify(data.font)}`);
    config.font = { ...DEFAULTS.font };
  } else {
    const raw = data.font || {};
    const font = { ...DEFAULTS.font, ...raw };
    const legacyCjk = raw.mode === undefined && raw.cjk === true;
    font.mode = raw.mode === undefined ? (legacyCjk ? 'cjk' : 'off') : raw.mode;
    if (!['off', 'project', 'cjk'].includes(font.mode)) {
      problems.push(`font.mode must be off, project or cjk, got ${JSON.stringify(font.mode)}`);
      font.mode = 'off';
    }
    font.file = stringField(raw.file, '', 'font.file', problems);
    font.dynamic = raw.dynamic === undefined ? 'labels' : raw.dynamic;
    if (!['labels', 'common'].includes(font.dynamic)) {
      problems.push(`font.dynamic must be labels or common, got ${JSON.stringify(font.dynamic)}`);
      font.dynamic = 'labels';
    }
    if (font.mode === 'project') {
      if (font.file === '') problems.push('font.file is required when font.mode is project');
      else {
        const why = relativePathProblem(rootAbs, font.file);
        if (why) {
          problems.push(`font.file must stay inside project: "${font.file}" (${why})`);
          font.file = '';
        }
      }
    }
    font.size = raw.size === undefined ? 16 : raw.size;
    if (!Number.isInteger(font.size) || font.size < 8 || font.size > 64) {
      problems.push(`font.size must be an integer between 8 and 64, got ${JSON.stringify(font.size)}`);
      font.size = 16;
    }
    font.name = stringField(raw.name, '', 'font.name', problems);
    if (font.name !== '' && !/^[A-Za-z_]\w*$/.test(font.name)) {
      problems.push(`font.name must be a C identifier, got "${font.name}"`);
    }
    font.cjk = font.mode === 'cjk';
    config.font = font;
  }

  return { ok: problems.length === 0, config, problems };
}

/** Write `<root>/lvglui.json`; callers are responsible for validating first. */
export function writeConfig(root, config) {
  const file = path.join(path.resolve(root), CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config ?? {}, null, 2)}\n`, 'utf8');
  return { file };
}

/** Derive absolute state/build/output paths from a normalized config. */
export function projectPaths(root, config) {
  const rootAbs = path.resolve(root);
  const stateDir = path.join(rootAbs, '.lvglui');
  const configured = config?.build?.dir;
  const dir = configured === undefined ? DEFAULTS.build.dir : configured;
  if (typeof dir !== 'string' || dir === '') {
    throw new Error(`build.dir must stay inside project: ${JSON.stringify(dir)} (expected a non-empty relative path)`);
  }
  const why = relativePathProblem(rootAbs, dir);
  if (why) throw new Error(`build.dir must stay inside project: "${dir}" (${why})`);
  const buildDir = path.resolve(rootAbs, dir);
  const outDir = path.join(stateDir, 'out');
  const lvConfPath = path.join(buildDir, 'lv_conf.h');
  return { stateDir, buildDir, outDir, lvConfPath };
}
