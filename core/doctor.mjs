// Read-only environment and project self-check. Never builds.
//
// `doctor` inspects the shared context (plus an optional already-discovered
// toolchain) and returns structured checks: `status` is `ok|warn|fail`.
// Failures are collected in `problems`, warnings in `warnings`; warnings never
// make `ok` false.

import fs from 'node:fs';
import path from 'node:path';

import { parseSdkconfig } from './kconfig.mjs';
import { readText } from './fsutil.mjs';
import { fontStatus } from './font.mjs';

const OBJ_NAME_KEY = 'LV_USE_OBJ_NAME';
const PLATFORM_INCLUDES = /^(?:driver\/|esp_|freertos\/|sdkconfig\.h$)/;
const ENTRY_RE = /^[A-Za-z_]\w*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// Recursively collect `.c` / `.h` files below `dir`; unreadable directories are
// skipped instead of aborting the whole doctor run.
function walkSources(dir, allowedExts) {
  const out = [];
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'build') continue;
        visit(full);
      } else if (entry.isFile() && allowedExts.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  visit(path.resolve(dir));
  return out.sort();
}

// Comments are stripped before scanning so `// #include "driver/x.h"` and
// block-commented includes do not produce false failures.
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

function kconfigMap(value) {
  if (value instanceof Map) return value;
  if (typeof value === 'string') {
    try {
      return parseSdkconfig(value);
    } catch {
      return new Map();
    }
  }
  if (isPlainObject(value)) return new Map(Object.entries(value));
  return new Map();
}

function kconfigValue(map, name) {
  if (map.has(name)) return map.get(name);
  if (map.has(`CONFIG_${name}`)) return map.get(`CONFIG_${name}`);
  return undefined;
}

function isEnabled(value) {
  return value === 1 || value === 'y' || value === true || value === 'Y';
}

function makeCheck(id, status, message, detail) {
  const check = { id, status, message };
  if (detail !== undefined) check.detail = detail;
  return check;
}

function checkProject(ctx) {
  if (!isPlainObject(ctx)) {
    return makeCheck('project', 'fail', '工程上下文缺失（ctx 未提供）');
  }
  if (typeof ctx.root !== 'string' || ctx.root === '') {
    return makeCheck('project', 'fail', '工程根目录未确定');
  }
  if (!isDirectory(ctx.root)) {
    return makeCheck('project', 'fail', `工程根目录不存在：${ctx.root}`);
  }
  if (ctx.ok === false) {
    const problems = Array.isArray(ctx.problems) ? ctx.problems : [];
    return makeCheck(
      'project',
      'fail',
      '工程上下文存在问题',
      problems.length > 0 ? problems : 'ctx.ok 为 false',
    );
  }
  return makeCheck('project', 'ok', `工程根目录：${ctx.root}`);
}

function checkIdf(ctx) {
  const idf = ctx?.idf;
  if (isPlainObject(idf) && typeof idf.path === 'string' && idf.path !== ''
    && isPlainObject(idf.version) && idf.version.major === 6) {
    return makeCheck('idf', 'ok', `ESP-IDF ${idf.version.major}.${idf.version.minor ?? '?'}：${idf.path}`);
  }
  return makeCheck(
    'idf',
    'fail',
    '未找到 ESP-IDF 6.x（v1 只支持 IDF 6）',
    isPlainObject(idf) ? { path: idf.path ?? null, version: idf.version ?? null, problem: idf.problem ?? null } : null,
  );
}

function checkLvgl(ctx) {
  const lvgl = ctx?.lvgl;
  if (!isPlainObject(lvgl) || typeof lvgl.dir !== 'string' || lvgl.dir === '') {
    return makeCheck('lvgl', 'fail', '未找到 LVGL 目录（lvgl.dir 为空）');
  }
  if (!isPlainObject(lvgl.version) || lvgl.version.major !== 9) {
    return makeCheck('lvgl', 'fail', `LVGL 版本不是 9.x：${JSON.stringify(lvgl.version)}`);
  }
  if (!isDirectory(path.join(lvgl.dir, 'src'))) {
    return makeCheck('lvgl', 'fail', `LVGL 源码目录缺失：${path.join(lvgl.dir, 'src')}`);
  }
  return makeCheck(
    'lvgl',
    'ok',
    `LVGL ${lvgl.version.major}.${lvgl.version.minor ?? '?'}：${lvgl.dir}`,
  );
}

function checkDisplay(ctx) {
  const display = ctx?.display;
  if (!isPlainObject(display)) {
    return makeCheck('display', 'fail', '分辨率未确定（display 缺失）');
  }
  const { width, height, colorDepth } = display;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return makeCheck(
      'display',
      'fail',
      `分辨率无效：${JSON.stringify({ width, height })}`,
    );
  }
  if (colorDepth !== 16) {
    return makeCheck('display', 'fail', `色深必须是 16，当前为 ${JSON.stringify(colorDepth)}`);
  }
  return makeCheck('display', 'ok', `分辨率 ${width}x${height}，色深 16`);
}

function checkUiDir(ctx) {
  const configured = typeof ctx?.configFile === 'string' && ctx.configFile !== '';
  if (typeof ctx?.uiDir !== 'string' || ctx.uiDir === '' || !isDirectory(ctx.uiDir)) {
    // Running doctor before init is a supported first step: the environment is
    // fine, the UI simply has not been injected yet. A lvglui.json that points
    // at a missing directory is a real problem, though.
    if (configured) {
      return makeCheck('uiDir', 'fail', `lvglui.json 里的 UI 目录不存在：${ctx?.uiDir ?? '(未设置)'}`);
    }
    return makeCheck(
      'uiDir',
      'warn',
      `还没找到 UI 目录（${ctx?.uiDir ?? '未设置'}）；下一步：lvglui init --project <root> --width <w> --height <h>`,
    );
  }
  const sources = Array.isArray(ctx.sources) ? ctx.sources : [];
  if (sources.length === 0) {
    return makeCheck('uiDir', 'warn', `UI 目录下还没有 C 源文件：${ctx.uiDir}（用 init 生成骨架，或把已有页面放进来）`);
  }
  return makeCheck('uiDir', 'ok', `UI 目录：${ctx.uiDir}（${sources.length} 个源文件）`);
}

function checkEntry(ctx) {
  const configured = typeof ctx?.configFile === 'string' && ctx.configFile !== '';
  if (typeof ctx?.entry !== 'string' || !ENTRY_RE.test(ctx.entry)) {
    if (configured) {
      return makeCheck('entry', 'fail', `lvglui.json 里的 UI 入口无效：${JSON.stringify(ctx?.entry ?? null)}`);
    }
    return makeCheck(
      'entry',
      'warn',
      `UI 入口未确定（${JSON.stringify(ctx?.entry ?? null)}）；init 会写入 ui_start`,
    );
  }
  return makeCheck('entry', 'ok', `UI 入口：${ctx.entry}`);
}

// No CMakeLists is normal for a bare UI directory, so only warn. SRC_DIRS is
// treated as full coverage. Explicit SRCS are compared by basename against all
// `.c` files below uiDir.
function checkSrces(ctx) {
  const uiDir = ctx?.uiDir;
  if (typeof uiDir !== 'string' || uiDir === '') {
    return makeCheck('srces', 'warn', 'UI 目录未确定，未检查 SRCS');
  }
  const cmake = path.join(uiDir, 'CMakeLists.txt');
  const text = readText(cmake);
  if (text === null) {
    return makeCheck('srces', 'warn', 'UI 目录没有 CMakeLists.txt，未检查 SRCS', { file: cmake });
  }
  if (/\bSRC_DIRS\b/.test(text)) {
    return makeCheck('srces', 'ok', 'UI CMakeLists 使用 SRC_DIRS，视为全覆盖');
  }

  const section = text.match(
    /\bSRCS\b([\s\S]*?)(?=\bSRC_DIRS\b|\bINCLUDE_DIRS\b|\bPRIV_INCLUDE_DIRS\b|\bREQUIRES\b|\bPRIV_REQUIRES\b|\bLDFRAGMENTS\b|\bEMBED_FILES\b|\bWHOLE_ARCHIVE\b|\))/,
  );
  if (!section) {
    return makeCheck('srces', 'warn', 'CMakeLists.txt 里没有 SRCS，未检查源文件覆盖', { file: cmake });
  }
  const tokens = [...section[1].matchAll(/([^\s"')]+\.c)/g)].map((m) => m[1]);
  if (tokens.length === 0) {
    return makeCheck('srces', 'warn', 'SRCS 无法解析为显式 .c 文件，未检查覆盖', { file: cmake });
  }

  const listed = new Set(tokens.map((token) => path.basename(token).toLowerCase()));
  const actual = walkSources(uiDir, new Set(['.c']));
  const missing = actual.filter((file) => !listed.has(path.basename(file).toLowerCase()));
  if (missing.length > 0) {
    const relatives = missing.map((file) => path.relative(uiDir, file).replace(/\\/g, '/'));
    return makeCheck(
      'srces',
      'fail',
      `UI 源文件未加入 SRCS：${relatives.join(', ')}`,
      { file: cmake, missing: relatives },
    );
  }
  return makeCheck('srces', 'ok', `SRCS 覆盖全部 ${actual.length} 个 UI 源文件`);
}

function checkPlatformHeaders(ctx) {
  const uiDir = ctx?.uiDir;
  if (typeof uiDir !== 'string' || uiDir === '' || !isDirectory(uiDir)) {
    return makeCheck('platformHeaders', 'warn', 'UI 目录未确定，未扫描平台头文件');
  }

  const hits = [];
  for (const file of walkSources(uiDir, new Set(['.c', '.h']))) {
    let text;
    try {
      text = stripComments(readText(file) ?? '');
    } catch {
      continue;
    }
    const includeRe = /^[ \t]*#include[ \t]*[<"]([^>"]+)[>"]/gm;
    for (const match of text.matchAll(includeRe)) {
      const target = match[1].trim().replace(/\\/g, '/');
      if (PLATFORM_INCLUDES.test(target)) {
        hits.push({ file, target });
      }
    }
  }
  if (hits.length > 0) {
    const relatives = hits.map((hit) => {
      const rel = path.relative(uiDir, hit.file).replace(/\\/g, '/');
      return `${rel}: ${hit.target}`;
    });
    return makeCheck(
      'platformHeaders',
      'fail',
      `UI 源码包含平台头文件：${relatives.join(', ')}（硬件访问应放到 ui_port 实现）`,
      { hits: relatives },
    );
  }
  return makeCheck('platformHeaders', 'ok', 'UI 源码没有平台头文件');
}

function checkToolchain(toolchain) {
  if (toolchain === undefined || toolchain === null) {
    return makeCheck('toolchain', 'warn', '未检查工具链（调用方未提供）');
  }
  if (!isPlainObject(toolchain)) {
    return makeCheck('toolchain', 'fail', '工具链信息格式无效');
  }
  if (toolchain.ok === false) {
    const problems = Array.isArray(toolchain.problems) ? toolchain.problems : [];
    return makeCheck(
      'toolchain',
      'fail',
      '工具链不完整',
      problems.length > 0 ? problems : 'toolchain.ok 为 false',
    );
  }

  const names = ['vcvars', 'cmake', 'ninja'];
  const explicitMissing = names.filter((key) => toolchain[key] === null);
  if (explicitMissing.length > 0) {
    return makeCheck(
      'toolchain',
      'fail',
      `未找到：${explicitMissing.join(', ')}`,
    );
  }
  const provided = names.filter((key) => typeof toolchain[key] === 'string' && toolchain[key] !== '');
  if (provided.length < names.length) {
    return makeCheck('toolchain', 'warn', '未完整检查工具链（只提供了部分路径或 ok 标记）');
  }
  const absent = provided.filter((key) => !fs.existsSync(toolchain[key]));
  if (absent.length > 0) {
    return makeCheck(
      'toolchain',
      'fail',
      `工具链文件不存在：${absent.map((key) => toolchain[key]).join(', ')}`,
    );
  }
  return makeCheck(
    'toolchain',
    'ok',
    `工具链：vcvars=${toolchain.vcvars}, cmake=${toolchain.cmake}, ninja=${toolchain.ninja}`,
  );
}

function checkUiPort(ctx) {
  // The header lives in the ui_port component (components/ui_port/include) in
  // the layout init generates; older projects keep it in the UI component.
  let header = '';
  if (typeof ctx?.portInclude === 'string' && ctx.portInclude !== '') {
    header = path.join(ctx.portInclude, 'ui_port.h');
  } else if (typeof ctx?.uiDir === 'string' && ctx.uiDir !== '') {
    header = path.join(ctx.uiDir, 'include', 'ui_port.h');
  }
  if (header === '' || !fs.existsSync(header)) {
    if (typeof ctx?.uiDir !== 'string' || ctx.uiDir === '') {
      return makeCheck('uiPort', 'warn', 'UI 目录未确定，未检查 ui_port.h');
    }
    if (ctx?.configFile == null || ctx.configFile === '') {
      return makeCheck(
        'uiPort',
        'warn',
        '未注入 UI 层：没有 ui_port.h，先运行 lvglui init 生成 UI 组件和 ui_port 组件',
        { file: ctx.uiDir },
      );
    }
    return makeCheck(
      'uiPort',
      'warn',
      `未找到 ui_port.h：期望 ${path.join(path.dirname(ctx.uiDir), 'ui_port', 'include', 'ui_port.h')} 或 ${header}；` +
        'ui_port 组件缺失时固件会报 undefined reference to ui_port_*',
      { file: header },
    );
  }

  // Declared-but-unimplemented accessors are the quiet failure mode: the host
  // build links against ui_port_stub.c, while the firmware build fails much
  // later with undefined reference. Report that gap here instead.
  const declarations = declaredUiPortFunctions(readText(header) ?? '');
  const impl = findUiPortImplementation(ctx, header);
  if (declarations.length === 0) {
    return makeCheck('uiPort', 'ok', `ui_port.h：${header}`, { file: header });
  }
  if (impl === null) {
    return makeCheck(
      'uiPort',
      'warn',
      `ui_port.h 声明了 ${declarations.length} 个函数，但找不到 ui_port_impl.c；`
        + '预览可用（stub），固件会 undefined reference',
      { file: header, declared: declarations },
    );
  }
  const defined = definedFunctions(readText(impl) ?? '');
  const missing = declarations.filter((name) => !defined.has(name));
  if (missing.length === 0) {
    return makeCheck(
      'uiPort',
      'ok',
      `ui_port.h：${declarations.length} 个声明均已在 ${path.relative(ctx.root, impl).replace(/\\/g, '/')} 实现`,
      { file: header, impl },
    );
  }
  return makeCheck(
    'uiPort',
    'warn',
    `ui_port.h 声明了 ${declarations.length} 个函数，${path.relative(ctx.root, impl).replace(/\\/g, '/')} 缺定义：`
      + `${missing.join(', ')}；预览由 stub 提供，固件会 undefined reference`,
    { file: header, impl, missing },
  );
}

function declaredUiPortFunctions(source) {
  const clean = stripComments(source);
  const found = new Set();
  const re = /(?:^|\n)[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*[ \t\*]+)+(ui_port_[A-Za-z0-9_]+)[ \t]*\([^;{}]*\)[ \t]*;/g;
  for (const match of clean.matchAll(re)) found.add(match[1]);
  return [...found];
}

function definedFunctions(source) {
  const clean = stripComments(source);
  const found = new Set();
  const re = /\b(ui_port_[A-Za-z0-9_]+)\s*\([^;{}]*\)\s*\{/g;
  for (const match of clean.matchAll(re)) found.add(match[1]);
  return found;
}

function findUiPortImplementation(ctx, header) {
  const candidates = [
    path.join(path.dirname(path.dirname(header)), 'ui_port_impl.c'),
    typeof ctx?.uiDir === 'string' ? path.join(ctx.uiDir, 'src', 'ui_port_impl.c') : '',
    typeof ctx?.uiDir === 'string' ? path.join(ctx.uiDir, 'ui_port_impl.c') : '',
  ].filter((value) => value !== '');
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function checkFont(ctx) {
  const config = ctx?.config?.font ?? {};
  const mode = config.mode ?? 'off';

  // A project font is a completely different thing from LVGL's built-in CJK
  // subset: when the generated C font is in use, the built-in font being off
  // is the normal state, not a warning.
  if (mode === 'project') {
    const status = fontStatus(ctx);
    if (!status.ok) {
      return makeCheck(
        'font',
        'fail',
        `工程字体配置存在但不可用：${(status.problems ?? ['未知原因']).join('；')}`,
        { mode, file: config.file ?? null },
      );
    }
    const missing = status.missing ?? [];
    if (missing.length > 0) {
      const shown = missing.slice(0, 12).map((cp) => `U+${cp.toString(16).toUpperCase()}`);
      return makeCheck(
        'font',
        'warn',
        `工程字体缺 ${missing.length} 个字符（${shown.join(' ')}${missing.length > shown.length ? ' …' : ''}）；`
          + 'UI 文本变了，重新运行 lvglui font add --project <工程> 生成',
        { mode, file: config.file ?? null, missing: missing.slice(0, 64) },
      );
    }
    return makeCheck(
      'font',
      'ok',
      `工程字体已启用：${config.file}（${status.glyphs} 字形，覆盖当前 UI 文本）`,
      { mode, file: config.file ?? null, glyphs: status.glyphs },
    );
  }

  if (mode === 'cjk') {
    return makeCheck('font', 'ok', 'lvglui.json 启用 LVGL 内置 CJK 字体（覆盖不完整，推荐 font add）', {
      mode,
    });
  }

  if (mode === 'freetype') {
    return makeCheck(
      'font',
      'ok',
      `FreeType 运行时字体：${config.file || '(未指定)'}；固件需 LV_USE_FREETYPE、esp_freetype 与文件系统`,
      { mode, file: config.file ?? null },
    );
  }

  // mode == "off": ASCII is the deliberate default. Warn only when the UI
  // actually contains non-ASCII text, instead of always nagging about the
  // built-in CJK font.
  const status = fontStatus(ctx);
  const missing = (status.missing ?? []).filter((cp) => cp > 0x7e);
  if (missing.length > 0) {
    const shown = missing.slice(0, 12).map((cp) => `U+${cp.toString(16).toUpperCase()}`);
    return makeCheck(
      'font',
      'warn',
      `UI 有 ${missing.length} 个非 ASCII 字符，但 font.mode=off（LVGL 只画 ASCII）；`
        + '运行 lvglui font add --preset noto-sans-sc --size <字号> 生成工程字体',
      { mode, missing: missing.slice(0, 32), shown },
    );
  }
  return makeCheck('font', 'ok', '未启用工程字体（font.mode=off），当前 UI 文本为纯 ASCII', { mode });
}

// The preview build forces LV_USE_OBJ_NAME on (tree.json needs the names), but
// the firmware may have it off. Then lv_obj_set_name() becomes a no-op and any
// name-based contract silently fails on the board while the preview looks fine.
function checkObjName(ctx) {
  const map = kconfigMap(ctx?.sdkconfig);
  const value = kconfigValue(map, OBJ_NAME_KEY);
  if (isEnabled(value)) return makeCheck('objName', 'ok', `${OBJ_NAME_KEY}=y，控件名在固件与预览中一致`);

  const uiDir = ctx?.uiDir;
  if (typeof uiDir !== 'string' || uiDir === '' || !isDirectory(uiDir)) {
    return makeCheck('objName', 'warn', `${OBJ_NAME_KEY} 未启用，且 UI 目录未确定，未检查 lv_obj_set_name 使用`);
  }
  const sources = walkSources(uiDir, new Set(['.c', '.h']));
  const users = [];
  for (const file of sources) {
    const source = stripComments(readText(file) ?? '');
    if (/\blv_obj_set_name\s*\(/.test(source)) {
      users.push(path.relative(uiDir, file).replace(/\\/g, '/'));
    }
  }
  if (users.length === 0) {
    return makeCheck('objName', 'ok', `${OBJ_NAME_KEY} 未启用，UI 也没有使用 lv_obj_set_name()`, { value: value ?? null });
  }
  return makeCheck(
    'objName',
    'warn',
    `${OBJ_NAME_KEY} 未启用，但 UI 在 ${users.join(', ')} 里调用了 lv_obj_set_name()；`
      + '控件名只会在预览里生效，固件上为空。请在 sdkconfig 打开 CONFIG_LV_USE_OBJ_NAME=y（或让页面用 #if LV_USE_OBJ_NAME 包住命名）',
    { value: value ?? null, files: users },
  );
}

// Users (and agents) need to know where the tool itself lives: the MCP server
// does not put `lvglui` on PATH, and print-checks otherwise only describe the
// project.
function checkTool(ctx) {
  const toolDir = typeof ctx?.toolDir === 'string' ? ctx.toolDir : '';
  if (toolDir === '') return makeCheck('tool', 'warn', '工具目录未知，无法报告 CLI 路径');
  let version = null;
  try {
    version = JSON.parse(readText(path.join(toolDir, 'package.json')) ?? '{}').version ?? null;
  } catch {
    version = null;
  }
  const cli = path.join(toolDir, 'cli', 'lvglui.mjs');
  return makeCheck(
    'tool',
    'ok',
    `lvglui ${version ?? '(未知版本)'}；CLI：node ${cli.split(path.sep).join('/')}`,
    { version, toolDir, cli, node: process.version },
  );
}

/**
 * @param {object} ctx shared project context from `loadContext`
 * @param {{toolchain?: object}} [options] result of `findToolchain` (optional)
 * @returns {{ok: boolean, checks: Array<{id: string, status: 'ok'|'warn'|'fail',
 *   message: string, detail?: any}>, problems: object[], warnings: object[]}}
 */
export function doctor(ctx, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const checks = [
    checkTool(ctx),
    checkProject(ctx),
    checkIdf(ctx),
    checkLvgl(ctx),
    checkDisplay(ctx),
    checkUiDir(ctx),
    checkEntry(ctx),
    checkSrces(ctx),
    checkPlatformHeaders(ctx),
    checkToolchain(opts.toolchain),
    checkUiPort(ctx),
    checkFont(ctx),
    checkObjName(ctx),
  ];

  const problems = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  return {
    ok: problems.length === 0,
    checks,
    problems,
    warnings,
  };
}