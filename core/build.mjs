// Generate the Windows build script that configures and builds the host
// targets (ui, shot, preview), then run it and capture a build log.

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { writeIfChanged } from './fsutil.mjs';
import { acquireBuildLock, describeHolder } from './buildlock.mjs';

const MAX_BUFFER = 32 * 1024 * 1024;

const CMakeEntries = [
  ['LVGLUI_TOOL_DIR', 'toolDir', 'PATH'],
  ['LVGLUI_PROJECT_DIR', 'root', 'PATH'],
  ['LVGLUI_UI_DIR', 'uiDir', 'PATH'],
  ['LVGLUI_LVGL_DIR', 'lvgl', 'PATH'],
  ['LVGLUI_CONF_DIR', 'buildDir', 'PATH'],
  ['LVGLUI_ENTRY', 'entry', 'STRING'],
  ['LVGLUI_WIDTH', 'width', 'STRING'],
  ['LVGLUI_HEIGHT', 'height', 'STRING'],
  ['LVGLUI_FONT_NAME', 'fontName', 'STRING'],
  ['LVGLUI_FREETYPE', 'freetype', 'BOOL'],
  ['LVGLUI_FREETYPE_DIR', 'freetypeDir', 'PATH'],
  ['LVGLUI_FONT_PATH', 'fontPath', 'FILEPATH'],
  ['LVGLUI_HAS_PAGES', 'hasPages', 'BOOL'],
  ['LVGLUI_PORT_INCLUDE', 'portInclude', 'PATH'],
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(ctx, field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`writeBuildScript: ctx.${field} is required`);
  }
  return value;
}

function requiredDimension(ctx, field, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`writeBuildScript: ctx.display.${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

// Parse the public `ctx` shape once; every failure here is a programmer error.
function readCtx(ctx) {
  if (!isPlainObject(ctx)) throw new Error('writeBuildScript: ctx must be an object');

  const toolDir = requiredText(ctx, 'toolDir', ctx.toolDir);
  const root = requiredText(ctx, 'root', ctx.root);
  const buildDir = requiredText(ctx, 'buildDir', ctx.buildDir);
  const uiDir = requiredText(ctx, 'uiDir', ctx.uiDir);
  const entry = requiredText(ctx, 'entry', ctx.entry);

  if (!isPlainObject(ctx.lvgl)) throw new Error('writeBuildScript: ctx.lvgl.dir is required');
  const lvglDir = requiredText(ctx, 'lvgl.dir', ctx.lvgl.dir);

  if (!isPlainObject(ctx.display)) {
    throw new Error('writeBuildScript: ctx.display.width and ctx.display.height are required');
  }
  const width = requiredDimension(ctx, 'width', ctx.display.width);
  const height = requiredDimension(ctx, 'height', ctx.display.height);

  if (!isPlainObject(ctx.toolchain)) throw new Error('writeBuildScript: ctx.toolchain is required');
  const vcvars = requiredText(ctx, 'toolchain.vcvars', ctx.toolchain.vcvars);
  const cmake = requiredText(ctx, 'toolchain.cmake', ctx.toolchain.cmake);
  const ninja = requiredText(ctx, 'toolchain.ninja', ctx.toolchain.ninja);
  const font = isPlainObject(ctx.config?.font) ? ctx.config.font : {};
  const fontName = font.mode === 'project' ? text(font.name) : '';
  if (fontName !== '' && !/^[A-Za-z_]\w*$/.test(fontName)) {
    throw new Error(`writeBuildScript: invalid font symbol: ${fontName}`);
  }
  const freetype = font.mode === 'freetype';
  const freetypeDir = freetype ? text(font.freetypeDir) : '';
  if (freetypeDir !== '' && (freetypeDir.includes('"') || freetypeDir.includes('\r') || freetypeDir.includes('\n'))) {
    throw new Error('writeBuildScript: invalid font.freetypeDir');
  }
  const fontPath = freetype && text(font.file) !== '' ? path.resolve(ctx.root, text(font.file)) : '';
  if (fontPath !== '' && (fontPath.includes('"') || fontPath.includes('\r') || fontPath.includes('\n'))) {
    throw new Error('writeBuildScript: invalid font.file');
  }
  // Optional page contract: ctx.pages comes from loadContext's static scan.
  // Compiling the host with LVGLUI_HAS_PAGES is what lets ui_entry.c call the
  // three ui_page_* symbols; without it they are simply not referenced.
  const hasPages = ctx.pages?.supported === true;
  const portInclude = typeof ctx.portInclude === 'string' && ctx.portInclude !== '' ? path.resolve(ctx.portInclude) : '';
  if (portInclude !== '' && (portInclude.includes('"') || portInclude.includes('\r') || portInclude.includes('\n'))) {
    throw new Error('writeBuildScript: ctx.portInclude must not contain quotes or newlines');
  }

  return {
    toolDir,
    root,
    buildDir: path.resolve(buildDir),
    uiDir,
    lvglDir,
    entry,
    width,
    height,
    fontName,
    freetype,
    freetypeDir,
    fontPath,
    hasPages,
    portInclude,
    vcvars,
    cmake,
    ninja,
  };
}

// Batch files cannot carry `%` in a path (cmd would expand it) and cannot
// represent a literal double quote. Reject both instead of writing a script
// that silently points somewhere else.
function cmdPath(value, label) {
  const text = String(value);
  if (text.includes('%')) {
    throw new Error(`writeBuildScript: ${label} must not contain "%": ${text}`);
  }
  if (text.includes('"')) {
    throw new Error(`writeBuildScript: ${label} must not contain a double quote: ${text}`);
  }
  if (text.includes('\r') || text.includes('\n')) {
    throw new Error(`writeBuildScript: ${label} must not contain a carriage return or newline`);
  }
  return text.replace(/\//g, '\\');
}

function cmdQuote(value, label) {
  return `"${cmdPath(value, label)}"`;
}

// CMake prefers forward slashes on Windows; a backslash inside a quoted
// argument is an escape sequence, so paths are normalized rather than escaped.
function cmakeQuote(value, label) {
  const text = String(value);
  if (text.includes('%')) {
    throw new Error(`writeBuildScript: ${label} must not contain "%": ${text}`);
  }
  if (text.includes('"')) {
    throw new Error(`writeBuildScript: ${label} must not contain a double quote: ${text}`);
  }
  if (text.includes('\r') || text.includes('\n')) {
    throw new Error(`writeBuildScript: ${label} must not contain a carriage return or newline`);
  }
  return `"${text.replace(/\\/g, '/')}"`;
}

function renderCache(values, buildDir) {
  const mapped = {
    toolDir: values.toolDir,
    root: values.root,
    uiDir: values.uiDir,
    lvgl: values.lvglDir,
    buildDir,
    entry: values.entry,
    width: String(values.width),
    height: String(values.height),
    fontName: values.fontName,
    freetype: values.freetype ? 'ON' : 'OFF',
    freetypeDir: values.freetypeDir,
    fontPath: values.fontPath,
    hasPages: values.hasPages ? 'ON' : 'OFF',
    portInclude: values.portInclude,
  };
  const lines = CMakeEntries.map(([name, key, type]) => (
    `set(${name} ${cmakeQuote(mapped[key], key)} CACHE ${type} "")`
  ));
  return `${lines.join('\n')}\n`;
}

function renderScript(values, buildDir, cacheScript) {
  const tmp = `${cmdPath(buildDir, 'buildDir')}\\tmp`;
  const lines = [
    '@echo off',
    `set "TMP=${tmp}"`,
    'set "TEMP=%TMP%"',
    'if not exist "%TMP%" mkdir "%TMP%"',
    `call ${cmdQuote(values.vcvars, 'toolchain.vcvars')} >nul`,
    'if errorlevel 1 exit /b 1',
    `${cmdQuote(values.cmake, 'toolchain.cmake')} -S ${cmdQuote(values.toolDir, 'toolDir')}`
      + ` -B ${cmdQuote(buildDir, 'buildDir')} -G Ninja`
      + ` "-DCMAKE_MAKE_PROGRAM=${cmdPath(values.ninja, 'toolchain.ninja')}"`
      + ` -C ${cmdQuote(cacheScript, 'cacheScript')}`,
    'if errorlevel 1 exit /b 1',
    `${cmdQuote(values.cmake, 'toolchain.cmake')} --build ${cmdQuote(buildDir, 'buildDir')} --target ui shot preview`,
  ];
  return `${lines.join('\n')}\n`;
}

function text(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Write `<buildDir>/lvglui.cmake` and `<buildDir>/build.cmd`.
 *
 * @param {object} ctx
 * @param {string} ctx.toolDir lvglui checkout (CMake source dir)
 * @param {string} ctx.root target project root
 * @param {string} ctx.buildDir state build directory
 * @param {string} ctx.uiDir UI source directory
 * @param {{dir: string}} ctx.lvgl LVGL source root
 * @param {string} ctx.entry UI entry function
 * @param {{width: number, height: number}} ctx.display preview size
 * @param {{vcvars: string, cmake: string, ninja: string}} ctx.toolchain
 * @returns {{script: string, cacheScript: string}} absolute generated paths
 */
export function writeBuildScript(ctx) {
  const values = readCtx(ctx);
  const cacheScript = path.join(values.buildDir, 'lvglui.cmake');
  const script = path.join(values.buildDir, 'build.cmd');

  clearStaleCmakeCache(values.buildDir, values);
  writeIfChanged(cacheScript, renderCache(values, values.buildDir));
  writeIfChanged(script, renderScript(values, values.buildDir, cacheScript));

  return { script, cacheScript };
}

// A checkout moved or cloned keeps the same relative .lvglui/build path, but
// CMakeCache.txt records the old tool source directory. Changing lvglui.json
// (uiDir/entry/font/lvgl) also leaves values that -C cannot override after the
// first configure. Clear only generated CMake/Ninja state when any of those
// inputs differs; keep lv_conf.h (written before buildHost) and the build log.
function clearStaleCmakeCache(buildDir, values) {
  const cacheFile = path.join(buildDir, 'CMakeCache.txt');
  if (!fs.existsSync(cacheFile)) return;
  const text = fs.readFileSync(cacheFile, 'utf8');

  const value = (key) => {
    const match = text.match(new RegExp(`^${key}:[^=]+=(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  };
  const samePath = (actual, expected) =>
    actual === null || path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase();

  const stale =
    !samePath(value('CMAKE_HOME_DIRECTORY'), values.toolDir) ||
    !samePath(value('LVGLUI_PROJECT_DIR'), values.root) ||
    !samePath(value('LVGLUI_UI_DIR'), values.uiDir) ||
    !samePath(value('LVGLUI_LVGL_DIR'), values.lvglDir) ||
    !samePath(value('LVGLUI_FONT_PATH'), values.fontPath) ||
    (value('LVGLUI_ENTRY') !== null && value('LVGLUI_ENTRY') !== values.entry) ||
    (value('LVGLUI_FONT_NAME') !== null && value('LVGLUI_FONT_NAME') !== values.fontName) ||
    (value('LVGLUI_FREETYPE') !== null && value('LVGLUI_FREETYPE') !== (values.freetype ? 'ON' : 'OFF')) ||
    (value('LVGLUI_FREETYPE_DIR') !== null && value('LVGLUI_FREETYPE_DIR') !== values.freetypeDir) ||
    (value('LVGLUI_HAS_PAGES') !== null && value('LVGLUI_HAS_PAGES') !== (values.hasPages ? 'ON' : 'OFF')) ||
    !samePath(value('LVGLUI_PORT_INCLUDE'), values.portInclude);

  if (!stale) return;

  for (const name of ['CMakeCache.txt', 'CMakeFiles', 'build.ninja', '.ninja_deps', '.ninja_log', 'cmake_install.cmake']) {
    fs.rmSync(path.join(buildDir, name), { recursive: true, force: true });
  }
}

/**
 * Run the generated build script. Never throws: spawn failures and invalid
 * contexts become `ok:false` with a message in `stderr`. A UTF-8 log with the
 * exact command plus combined stdout/stderr is always attempted.
 *
 * @param {object} ctx same shape as `writeBuildScript`
 * @param {{quiet?: boolean, run?: Function}} [options] `quiet` is accepted for
 *   call-site symmetry; `buildHost` always captures output and never prints it.
 * @returns {{ok: boolean, exitCode: number|null, durationMs: number,
 *   stdout: string, stderr: string, logPath: string|null}}
 */
export function buildHost(ctx, options = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const opts = isPlainObject(options) ? options : {};
  const injectedRun = typeof opts.run === 'function' ? opts.run : null;

  // Serialize with any other lvglui process (a second CLI/MCP call, or the
  // preview window's watcher) before touching CMake/Ninja state.
  const lockRoot = typeof ctx?.buildDir === 'string' && ctx.buildDir !== '' ? ctx.buildDir : null;
  const lock = lockRoot
    ? acquireBuildLock(lockRoot, {
        timeoutMs: Number.isFinite(opts.lockTimeoutMs) ? opts.lockTimeoutMs : 10_000,
        purpose: 'build',
      })
    : { ok: true, release() {} };
  if (!lock.ok) {
    return {
      ok: false,
      exitCode: null,
      durationMs: elapsed(),
      stdout: '',
      stderr: `another lvglui build is running: ${describeHolder(lock.holder)}`,
      logPath: null,
      busy: { holder: lock.holder, dir: lock.dir },
    };
  }

  try {
  let script;
  try {
    ({ script } = writeBuildScript(ctx));
  } catch (e) {
    return {
      ok: false,
      exitCode: null,
      durationMs: elapsed(),
      stdout: '',
      stderr: e.message,
      logPath: null,
    };
  }

  const buildDir = path.dirname(script);
  const logPath = path.join(buildDir, 'build.log');
  const command = `cmd.exe /c "${script}"`;

  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let ok = false;

  try {
    const runOptions = {
      cwd: buildDir,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    };
    const result = injectedRun
      ? injectedRun('cmd.exe', ['/c', script], runOptions)
      : spawnSync('cmd.exe', ['/c', script], runOptions);

    if (result && result.error) {
      stderr = text(result.error.message);
      exitCode = null;
    } else {
      stdout = text(result?.stdout);
      stderr = text(result?.stderr);
      exitCode = typeof result?.status === 'number' ? result.status : null;
      ok = exitCode === 0;
    }
  } catch (e) {
    stderr = e.message;
    exitCode = null;
  }

  let combined = stdout;
  if (stderr) {
    if (combined && !combined.endsWith('\n')) combined += '\n';
    combined += stderr;
  }

  let logText = `$ ${command}\n\n${combined}`;
  if (!logText.endsWith('\n')) logText += '\n';
  let writtenLogPath = null;
  try {
    writeIfChanged(logPath, logText);
    writtenLogPath = logPath;
  } catch (e) {
    stderr = stderr ? `${stderr}\n${e.message}` : e.message;
  }

  return {
    ok,
    exitCode,
    durationMs: elapsed(),
    stdout,
    stderr,
    logPath: writtenLogPath,
  };
  } finally {
    lock.release();
  }
}