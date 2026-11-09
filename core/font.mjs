// `font`: project-local Noto Sans SC subset generation.
//
// The tool ships one OFL font (assets/fonts/NotoSansSC-Regular.ttf). A project
// opts in with `font add`; only the characters used by its UI are converted to
// a C font, and the same C file is compiled into both preview and firmware.
// `font off` removes the generated artifacts and the theme hook.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_OVERRIDES } from './kconfig.mjs';
import { writeConfig } from './config.mjs';

export const FONT_PRESET = 'noto-sans-sc';
export const BUNDLED_FONT = 'assets/fonts/NotoSansSC-Regular.ttf';
export const COMMON_FONT = 'assets/fonts/common-gb2312-level1.txt';
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 64;
export const FONT_DYNAMICS = ['labels', 'common'];
const FONT_DIR = 'fonts';
const HEADER_NAME = 'ui_font.h';
const MAX_SYMBOLS = 20000;

const INCLUDE_BEGIN = '/* lvglui:font-include:begin */';
const INCLUDE_END = '/* lvglui:font-include:end */';
const BLOCK_BEGIN = '/* lvglui:font:begin */';
const BLOCK_END = '/* lvglui:font:end */';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function asciiChars() {
  const chars = [];
  for (let code = 0x20; code <= 0x7e; code++) chars.push(String.fromCharCode(code));
  return chars;
}

/**
 * Read the bundled GB2312 level-1 character set (3755 common Hanzi). The
 * file is plain text; whitespace is only layout. Keeping the list as data
 * makes the generated font deterministic and lets users inspect it.
 *
 * @param {string} toolDir tool checkout root
 * @returns {string[]}
 */
export function readCommonCharacters(toolDir) {
  const file = path.join(toolDir, COMMON_FONT);
  if (!fs.existsSync(file)) throw new Error(`常用字库不存在: ${file}`);
  const source = fs.readFileSync(file, 'utf8');
  const chars = [];
  const seen = new Set();
  for (const ch of source) {
    const cp = ch.codePointAt(0);
    if (cp < 0x4e00 || cp > 0x9fff || seen.has(ch)) continue;
    seen.add(ch);
    chars.push(ch);
  }
  return chars.sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
}

// Decode the handful of C escapes that matter for labels. Unknown escapes keep
// the escaped character, which is the closest readable approximation.
function decodeCString(value) {
  return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_, esc) => {
    if (esc[0] === 'x' || esc[0] === 'u') {
      if (esc[0] === 'x' && esc.length === 3) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc[0] === 'u' && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    }
    if (/^[0-7]{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return esc;
    }
  });
}

function walkCFiles(dir, out, depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '.git') continue;
      walkCFiles(full, out, depth + 1);
    } else if (entry.isFile() && /\.(c|h)$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Collect the characters that appear in C string literals under the UI dir.
 * Comments are not parsed; false positives only make the subset slightly
 * larger, never smaller.
 *
 * @param {string} uiDir absolute UI source directory
 * @returns {{chars:string[], files:string[], warnings:string[]}}
 */
export function collectUiCharacters(uiDir) {
  const files = [];
  const chars = new Set();
  const warnings = [];
  walkCFiles(uiDir, files);
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      warnings.push(`cannot read ${file}: ${e.message}`);
      continue;
    }
    for (const match of source.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      for (const ch of decodeCString(match[1])) {
        const cp = ch.codePointAt(0);
        if (cp === undefined || cp < 0x20 || cp === 0x7f) continue;
        chars.add(ch);
      }
    }
  }
  const ordered = [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  return { chars: ordered, files, warnings };
}

function parseCodepoints(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  const set = new Set();
  for (const match of source.matchAll(/\/\*\s*U\+([0-9A-Fa-f]{1,6})\b/g)) {
    set.add(parseInt(match[1], 16));
  }
  return set;
}

/**
 * Apply the tool's deterministic preview overrides, with the CJK built-in
 * fonts only when the project explicitly selects the legacy `cjk` mode.
 * This is deliberately shared by the sdkconfig path and the fallback copy so
 * both paths produce the same lv_conf.h semantics.
 *
 * @param {object|null} config normalized project config
 * @returns {Record<string,string>}
 */
export function previewOverrides(config) {
  const overrides = { ...DEFAULT_OVERRIDES };
  const mode = config?.font?.mode;
  if (mode !== 'cjk') {
    delete overrides.LV_FONT_SOURCE_HAN_SANS_SC_14_CJK;
    delete overrides.LV_FONT_SOURCE_HAN_SANS_SC_16_CJK;
  }
  return overrides;
}

function defaultRun(args, { cwd }) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function lvFontConvPath(toolDir) {
  return path.join(toolDir, 'node_modules', 'lv_font_conv', 'lv_font_conv.js');
}

function findFunctionBody(source, name = 'ui_theme_init') {
  const re = new RegExp(`\\bvoid\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const match = re.exec(source);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  let inBlock = false;
  let inLine = false;
  let inString = false;
  let inChar = false;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString || inChar) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (inString && ch === '"') inString = false;
      else if (inChar && ch === "'") inChar = false;
      continue;
    }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "'") { inChar = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

function stripFontMarkers(source) {
  return source
    .replace(/\/\* lvglui:font-include:begin \*\/[\s\S]*?\/\* lvglui:font-include:end \*\/\n?/g, '')
    .replace(/\/\* lvglui:font:begin \*\/[\s\S]*?\/\* lvglui:font:end \*\/\n?/g, '');
}

function patchTheme(source, symbol) {
  let out = stripFontMarkers(source);
  const body = findFunctionBody(out);
  if (!body) return { ok: false, text: source, reason: '找不到 void ui_theme_init(lv_obj_t *root) 函数' };

  const block = `\n    ${BLOCK_BEGIN}\n    lv_obj_set_style_text_font(root, &LVGLUI_FONT_NAME, 0);\n    ${BLOCK_END}\n`;
  out = `${out.slice(0, body.close)}${block}${out.slice(body.close)}`;

  const include = `${INCLUDE_BEGIN}\n#include "ui_font.h"\n${INCLUDE_END}\n`;
  const firstInclude = /^#include[^\n]*\n/m.exec(out);
  if (firstInclude) {
    const at = firstInclude.index + firstInclude[0].length;
    out = `${out.slice(0, at)}${include}${out.slice(at)}`;
  } else {
    out = `${include}${out}`;
  }
  return { ok: true, text: out, reason: '' };
}

function patchCMake(source, relFile) {
  if (/\bSRC_DIRS\b/.test(source)) return { changed: false, text: source, reason: 'SRC_DIRS' };
  if (source.includes(`"${relFile}"`)) return { changed: false, text: source, reason: 'present' };
  const line = `    "${relFile}"\n`;
  const marker = /\n([ \t]*INCLUDE_DIRS)/;
  if (marker.test(source)) {
    return { changed: true, text: source.replace(marker, `\n${line}$1`), reason: 'SRCS' };
  }
  const close = source.lastIndexOf(')');
  if (close === -1) return { changed: false, text: source, reason: 'no close paren' };
  return { changed: true, text: `${source.slice(0, close)}${line}${source.slice(close)}`, reason: 'SRCS' };
}

function escapeRegExp(value) {
  const special = '.*+?^${}()|[]\\';
  let out = '';
  for (const ch of value) out += special.includes(ch) ? '\\' + ch : ch;
  return out;
}

function removeCMakeLine(source, relFile) {
  const re = new RegExp('^[ \t]*"' + escapeRegExp(relFile) + '"[ \t]*\r?\n?', 'm');
  return source.replace(re, '');
}

function fontFailure(message, problems = [message]) {
  return { ok: false, mode: 'off', file: '', symbol: '', problems, warnings: [] };
}

// Remove every file this feature generates, including files from an older
// `font add` (the configured symbol can change), and their CMake SRCS lines.
function removeGeneratedArtifacts(uiDir) {
  const removed = new Set();
  const cmakePath = path.join(uiDir, 'CMakeLists.txt');
  let cmake = fs.existsSync(cmakePath) ? fs.readFileSync(cmakePath, 'utf8') : null;
  const drop = (abs) => {
    if (cmake !== null) cmake = removeCMakeLine(cmake, toPosix(path.relative(uiDir, abs)));
    removed.add(abs);
  };

  const fontsDir = path.join(uiDir, FONT_DIR);
  if (fs.existsSync(fontsDir)) {
    for (const entry of fs.readdirSync(fontsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^ui_font_[A-Za-z0-9_]+\.c$/.test(entry.name)) continue;
      const abs = path.join(fontsDir, entry.name);
      drop(abs);
      fs.rmSync(abs, { force: true });
    }
    try {
      if (fs.readdirSync(fontsDir).length === 0) fs.rmdirSync(fontsDir);
    } catch {
      // A user may have put a non-generated file here; keep the directory.
    }
  }

  const applyPath = path.join(uiDir, 'src', 'ui_font_apply.c');
  if (fs.existsSync(applyPath) && fs.readFileSync(applyPath, 'utf8').includes('Generated by lvglui font add')) {
    drop(applyPath);
    fs.rmSync(applyPath, { force: true });
  }

  const header = path.join(uiDir, 'include', HEADER_NAME);
  if (fs.existsSync(header) && fs.readFileSync(header, 'utf8').includes('Generated by lvglui font add')) {
    fs.rmSync(header, { force: true });
    removed.add(header);
  }

  const themePath = path.join(uiDir, 'src', 'ui_theme.c');
  if (fs.existsSync(themePath)) {
    const original = fs.readFileSync(themePath, 'utf8');
    const stripped = stripFontMarkers(original).replace(/[ \t]+$/gm, '');
    if (stripped !== original) {
      fs.writeFileSync(themePath, stripped, 'utf8');
      removed.add(themePath);
    }
  }

  if (cmake !== null) {
    const current = fs.readFileSync(cmakePath, 'utf8');
    if (cmake !== current) fs.writeFileSync(cmakePath, cmake, 'utf8');
  }
  return [...removed];
}

/**
 * Generate a project-local font subset from the bundled Noto Sans SC or a
 * user-provided TTF/OTF.
 *
 * @param {object} ctx `loadContext` result
 * @param {{fontPath?:string,preset?:string,size?:number,chars?:string,name?:string,run?:Function}} [options]
 */
export function fontAdd(ctx, options = {}) {
  if (!isPlainObject(ctx) || ctx.ok === false) {
    return fontFailure('工程上下文无效', ctx?.problems ?? ['工程上下文无效']);
  }
  if (text(ctx.root) === '' || text(ctx.uiDir) === '') {
    return fontFailure('工程缺少 root/uiDir');
  }

  const size = options.size ?? ctx.config?.font?.size ?? 16;
  if (!Number.isInteger(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) {
    return fontFailure(`字体大小必须是 ${FONT_SIZE_MIN}..${FONT_SIZE_MAX} 的整数`);
  }

  const dynamic = text(options.dynamic) === '' ? 'labels' : options.dynamic;
  if (!FONT_DYNAMICS.includes(dynamic)) {
    return fontFailure(`不支持的字体模式: ${dynamic}`);
  }

  const preset = options.preset ?? '';
  let sourceFont;
  if (text(options.fontPath) !== '') {
    if (preset !== '') return fontFailure('不能同时指定字体文件和 --preset');
    sourceFont = path.resolve(process.cwd(), options.fontPath);
  } else {
    const name = preset === '' ? FONT_PRESET : preset;
    if (name !== FONT_PRESET) return fontFailure(`不支持的字体预设: ${name}`);
    sourceFont = path.join(ctx.toolDir, BUNDLED_FONT);
  }
  if (!fs.existsSync(sourceFont)) return fontFailure(`字体文件不存在: ${sourceFont}`);

  const root = path.resolve(ctx.root);
  const uiDir = path.resolve(root, ctx.uiDir);
  const themePath = path.join(uiDir, 'src', 'ui_theme.c');
  removeGeneratedArtifacts(uiDir);
  const hasTheme = fs.existsSync(themePath);
  const originalTheme = hasTheme ? fs.readFileSync(themePath, 'utf8') : '';
  if (hasTheme && !findFunctionBody(originalTheme)) {
    return fontFailure('无法自动接入字体：ui_theme.c 中没有 void ui_theme_init(lv_obj_t *root)');
  }

  const ui = collectUiCharacters(uiDir);
  const symbols = new Set([...asciiChars(), ...ui.chars]);
  if (dynamic === 'common') {
    try {
      for (const ch of readCommonCharacters(ctx.toolDir)) symbols.add(ch);
    } catch (e) {
      return fontFailure(e.message);
    }
  }
  for (const ch of text(options.chars)) symbols.add(ch);
  const clean = [...symbols].filter((ch) => {
    const cp = ch.codePointAt(0);
    return cp !== undefined && cp >= 0x20 && cp !== 0x7f;
  }).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  if (clean.length === 0) return fontFailure('没有可生成的字符');
  if (clean.length > MAX_SYMBOLS) {
    return fontFailure(`需要生成的字符太多（${clean.length} > ${MAX_SYMBOLS}），请用 --chars 缩小范围`);
  }

  const suggested = text(options.name) !== ''
    ? options.name
    : `ui_font_${text(options.fontPath) === '' ? 'noto_sc' : 'custom'}_${size}${dynamic === 'common' ? '_common' : ''}`;
  if (!/^[A-Za-z_]\w*$/.test(suggested)) return fontFailure(`字体符号名不合法: ${suggested}`);

  const fontsDir = path.join(uiDir, FONT_DIR);
  const cfile = path.join(fontsDir, `${suggested}.c`);
  const header = path.join(uiDir, 'include', HEADER_NAME);
  fs.mkdirSync(fontsDir, { recursive: true });
  fs.mkdirSync(path.dirname(header), { recursive: true });

  const conv = lvFontConvPath(ctx.toolDir);
  if (!fs.existsSync(conv)) {
    return fontFailure('缺少 lv_font_conv，请先在工具目录运行 npm install');
  }

  const args = [
    conv,
    '--size', String(size),
    '--bpp', '4',
    '--format', 'lvgl',
    '--no-compress',
    '--font', sourceFont,
    '--symbols', clean.join(''),
    '--lv-font-name', suggested,
    '--output', cfile,
  ];
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  let result;
  try {
    result = run(args, { cwd: ctx.toolDir });
  } catch (e) {
    return fontFailure(`字体转换失败: ${e.message}`);
  }
  if (!result || result.status !== 0 || !fs.existsSync(cfile)) {
    const detail = text(result?.stderr).trim() || text(result?.stdout).trim();
    return fontFailure(`字体转换失败${detail ? `: ${detail}` : ''}`);
  }

  const glyphs = parseCodepoints(cfile);
  const requested = new Set(clean.map((ch) => ch.codePointAt(0)));
  const missing = [...requested].filter((cp) => !glyphs.has(cp)).sort((a, b) => a - b);

  const headerText = `/* Generated by lvglui font add. Do not edit. */\n#pragma once\n#include "lvgl.h"\n\nLV_FONT_DECLARE(${suggested});\n#define LVGLUI_FONT_NAME ${suggested}\n\nvoid lvglui_apply_font(lv_obj_t *root);\n`;
  fs.writeFileSync(header, headerText, 'utf8');

  // Preview compiles ui_entry.c with -DLVGLUI_FONT_NAME and calls this hook
  // after the entry function creates the screen. Firmware can either use
  // ui_theme.c (when present) or call lvglui_apply_font() itself.
  const applyPath = path.join(uiDir, 'src', 'ui_font_apply.c');
  fs.mkdirSync(path.dirname(applyPath), { recursive: true });
  fs.writeFileSync(applyPath, `/* Generated by lvglui font add. Do not edit. */\n#include "ui_font.h"\n\nvoid lvglui_apply_font(lv_obj_t *root)\n{\n    if (root != NULL) lv_obj_set_style_text_font(root, &${suggested}, 0);\n}\n`, 'utf8');

  const warnings = [...ui.warnings];
  if (hasTheme) {
    const patched = patchTheme(originalTheme, suggested);
    if (!patched.ok) {
      return fontFailure(patched.reason);
    }
    fs.writeFileSync(themePath, patched.text, 'utf8');
  } else {
    warnings.push('未找到 src/ui_theme.c；已生成 src/ui_font_apply.c，预览会自动应用，固件需在 ui_start 后调用 lvglui_apply_font(lv_screen_active())');
  }

  const cmakePath = path.join(uiDir, 'CMakeLists.txt');
  if (missing.length > 0) warnings.push(`字体缺字: ${missing.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(', ')}`);
  if (fs.existsSync(cmakePath)) {
    const cmake = fs.readFileSync(cmakePath, 'utf8');
    let nextCmake = cmake;
    for (const abs of [cfile, applyPath]) {
      const relFile = toPosix(path.relative(uiDir, abs));
      nextCmake = patchCMake(nextCmake, relFile).text;
    }
    if (nextCmake !== cmake) fs.writeFileSync(cmakePath, nextCmake, 'utf8');
  } else {
    warnings.push(`未找到 ${cmakePath}；请把字体源文件加入 UI 组件 SRCS`);
  }

  const relFile = toPosix(path.relative(root, cfile));
  const nextConfig = {
    ...ctx.config,
    font: { mode: 'project', dynamic, file: relFile, size, name: suggested, cjk: false },
  };
  writeConfig(root, nextConfig);

  return {
    ok: true,
    mode: 'project',
    dynamic,
    file: relFile,
    symbol: suggested,
    size,
    chars: clean.length,
    glyphs: glyphs.size,
    missing,
    warnings,
    problems: [],
    config: nextConfig,
  };
}

/**
 * Remove the generated font and its theme hook, then mark the project as
 * "no font". Files are only deleted when they live under the UI component.
 */
export function fontOff(ctx) {
  if (!isPlainObject(ctx) || ctx.ok === false) {
    return { ok: false, removed: [], problems: ctx?.problems ?? ['工程上下文无效'] };
  }
  const root = path.resolve(ctx.root);
  const uiDir = path.resolve(root, ctx.uiDir);
  const removed = removeGeneratedArtifacts(uiDir).map((abs) => toPosix(path.relative(root, abs)));
  const problems = [];

  const nextConfig = {
    ...ctx.config,
    font: { mode: 'off', dynamic: 'labels', file: '', size: ctx.config?.font?.size ?? 16, name: '', cjk: false },
  };
  writeConfig(root, nextConfig);
  return { ok: true, removed, problems, config: nextConfig };
}

/**
 * Report the current font policy plus the missing glyphs for the current UI
 * strings. `font mode off` is not a failure; it is an explicit choice.
 */
export function fontStatus(ctx) {
  if (!isPlainObject(ctx) || ctx.ok === false) {
    return { ok: false, mode: 'off', missing: [], problems: ctx?.problems ?? ['工程上下文无效'] };
  }
  const root = path.resolve(ctx.root);
  const uiDir = path.resolve(root, ctx.uiDir);
  const ui = collectUiCharacters(uiDir);
  const requested = new Set([...asciiChars(), ...ui.chars]);
  const font = ctx.config?.font ?? {};
  const mode = font.mode ?? 'off';
  const result = {
    ok: true,
    mode,
    dynamic: font.dynamic ?? 'labels',
    size: font.size ?? 16,
    file: text(font.file),
    symbol: text(font.name),
    chars: requested.size,
    glyphs: 0,
    missing: [],
    warnings: [...ui.warnings],
    problems: [],
  };

  if (mode === 'off') {
    result.missing = [...requested].filter((ch) => ch.codePointAt(0) > 0x7e);
    if (result.missing.length > 0) {
      result.warnings.push('字体未启用；UI 里的非 ASCII 字符不会显示');
    }
    return result;
  }

  if (mode === 'cjk') {
    result.warnings.push('使用 LVGL 自带 CJK 子集，覆盖不完整；建议用 font add 生成工程字体');
    return result;
  }

  if (mode !== 'project') {
    result.ok = false;
    result.problems.push(`未知字体模式: ${mode}`);
    return result;
  }

  const abs = path.resolve(root, text(font.file));
  if (text(font.file) === '' || !fs.existsSync(abs)) {
    result.ok = false;
    result.problems.push(`字体文件不存在: ${font.file || '(empty)'}`);
    return result;
  }
  const glyphs = parseCodepoints(abs);
  result.glyphs = glyphs.size;
  result.missing = [...requested]
    .filter((ch) => !glyphs.has(ch.codePointAt(0)))
    .sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  if (result.missing.length > 0) {
    result.warnings.push(`字体缺 ${result.missing.length} 个字符；重新运行 font add 生成`);
  }
  return result;
}