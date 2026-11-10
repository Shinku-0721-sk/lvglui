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

const CJK_FONT_KEY = 'LV_FONT_SOURCE_HAN_SANS_SC_16_CJK';
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
  if (typeof ctx?.portInclude === 'string' && ctx.portInclude !== '') {
    return makeCheck('uiPort', 'ok', `ui_port.h：${path.join(ctx.portInclude, 'ui_port.h')}`);
  }
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
  const header = path.join(ctx.uiDir, 'include', 'ui_port.h');
  return makeCheck(
    'uiPort',
    'warn',
    `未找到 ui_port.h：期望 ${path.join(path.dirname(ctx.uiDir), 'ui_port', 'include', 'ui_port.h')} 或 ${header}；` +
      'ui_port 组件缺失时固件会报 undefined reference to ui_port_*',
    { file: header },
  );
}

function checkFont(ctx) {
  const configCjk = ctx?.config?.font?.cjk === true;
  const map = kconfigMap(ctx?.sdkconfig);
  const value = kconfigValue(map, CJK_FONT_KEY);
  if (configCjk || isEnabled(value)) {
    return makeCheck(
      'font',
      'ok',
      configCjk ? 'lvglui.json 强制启用 CJK 字体' : `${CJK_FONT_KEY}=y`,
    );
  }
  return makeCheck(
    'font',
    'warn',
    '未启用 CJK 字体（sdkconfig 无 CONFIG_LV_FONT_SOURCE_HAN_SANS_SC_16_CJK=y，config.font.cjk 非 true）',
    { value: value ?? null },
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