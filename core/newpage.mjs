// `new`: add one page to a template-style multi-page UI and register it in
// `src/ui_pages.c`. Deliberately strict: only the `s_pages[]` table emitted by
// `init` (and harmless reformatting of it) is understood. Anything else is
// rejected instead of guessed. Every write is preceded by a backup and
// verified afterwards; a failed insert restores the table and removes the
// files this call created, so the project is never left half-edited.

import fs from 'node:fs';
import path from 'node:path';

import { readText, writeIfChanged } from './fsutil.mjs';

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const NAME_MAX = 48;
const BACKUP_DIR = path.join('.lvglui', 'backup');

const TABLE_OPEN_RE = /^\s*\}\s*s_pages\s*\[\s*\]\s*=\s*\{\s*$/;
const CLOSE_RE = /^\s*\}\s*;\s*$/;
const ENTRY_RE = /^\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*([A-Za-z_]\w*)\s*\}\s*(.*)$/;
const INCLUDE_PAGES_RE = /^\s*#include\s+"pages\/[^"]+"\s*$/;
const INCLUDE_UI_PAGES_RE = /^\s*#include\s+"ui_pages\.h"\s*$/;

// Enough C to keep a page named `for` or `struct` out of the build.
const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function fail(stage, problems) {
  return { ok: false, stage, problems: problems.filter(Boolean) };
}

// Line table with offsets so insertions can preserve the file's own EOLs and
// BOM instead of re-serializing it.
function splitLines(text) {
  const lines = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++;
    let eol = '';
    if (text[j] === '\r' && text[j + 1] === '\n') eol = '\r\n';
    else if (j < text.length) eol = text[j];
    lines.push({ start: i, contentEnd: j, end: j + eol.length, eol, text: text.slice(i, j) });
    i = j + eol.length;
  }
  return lines;
}

function parseTable(text) {
  const lines = splitLines(text);
  const openers = [];
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_OPEN_RE.test(lines[i].text)) openers.push(i);
  }
  if (openers.length === 0) {
    return fail('usage', ['没找到 `} s_pages[] = {` 页面表；ui_pages.c 不是 `init` 生成的模板？']);
  }
  if (openers.length > 1) {
    return fail('usage', [`找到 ${openers.length} 个 s_pages[] 表，无法确定该改哪一个`]);
  }

  const opener = openers[0];
  let closer = -1;
  for (let i = opener + 1; i < lines.length; i++) {
    if (CLOSE_RE.test(lines[i].text)) { closer = i; break; }
  }
  if (closer === -1) {
    return fail('usage', ['页面表没有找到结束行 `};`，括号不完整？']);
  }

  const entries = [];
  for (let i = opener + 1; i < closer; i++) {
    const raw = lines[i].text;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*')
      || trimmed.startsWith('*') || trimmed.endsWith('*/')) {
      continue;
    }
    const match = trimmed.match(ENTRY_RE);
    if (!match) {
      return fail('usage', [`页面表第 ${i + 1} 行不是单行条目，无法安全插入：${trimmed}`]);
    }
    const rest = match[3].trim();
    if (!/^,?\s*(?:\/\*.*\*\/)?$/.test(rest)) {
      return fail('usage', [`页面表第 ${i + 1} 行有无法识别的内容：${trimmed}`]);
    }
    entries.push({
      name: match[1],
      symbol: match[2],
      line: i,
      indent: raw.match(/^\s*/)[0],
    });
  }

  return { ok: true, lines, opener, closer, entries };
}

function findIncludeAnchor(lines) {
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (INCLUDE_PAGES_RE.test(lines[i].text)) anchor = i;
  }
  if (anchor !== -1) return anchor;
  for (let i = 0; i < lines.length; i++) {
    if (INCLUDE_UI_PAGES_RE.test(lines[i].text)) anchor = i;
  }
  return anchor;
}

// Returns `line` with a trailing comma, or null when the line is not a simple
// `{ "name", symbol }` entry.
function withTrailingComma(line) {
  const match = line.match(/^(\s*\{\s*"(?:[^"\\]|\\.)*"\s*,\s*[A-Za-z_]\w*\s*\})(\s*)(.*)$/);
  if (!match) return null;
  const rest = match[3].trim();
  if (rest.startsWith(',')) return line;
  if (rest === '') return `${match[1]},${match[2]}`;
  if (rest.startsWith('/*') && rest.endsWith('*/')) return `${match[1]},${match[2]}${match[3]}`;
  return null;
}

function insertAfterLine(text, line, payload) {
  const eol = line.eol || '\n';
  if (line.eol === '') return `${text.slice(0, line.contentEnd)}\n${payload}`;
  return `${text.slice(0, line.end)}${payload}${eol}${text.slice(line.end)}`;
}

// Append after `index`, rewriting that line first when it lacks a comma.
function insertEntryAfter(text, lines, index, payload) {
  const line = lines[index];
  if (line === undefined) return null;
  const fixed = withTrailingComma(line.text);
  if (fixed === null) return null;
  const textWithFixed = `${text.slice(0, line.start)}${fixed}${text.slice(line.contentEnd)}`;
  const fixedLine = { ...line, text: fixed, contentEnd: line.start + fixed.length, end: line.start + fixed.length + line.eol.length };
  return insertAfterLine(textWithFixed, fixedLine, payload);
}

function titleOf(name) {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function pageHeader(name) {
  return [
    '#pragma once',
    '#include "lvgl.h"',
    `lv_obj_t *ui_page_${name}_create(lv_obj_t *parent);`,
    '',
  ].join('\n');
}

export function pageSource(name) {
  return [
    '#include "lvgl.h"',
    `#include "pages/${name}.h"`,
    '',
    `lv_obj_t *ui_page_${name}_create(lv_obj_t *parent) {`,
    '    lv_obj_t *page = lv_obj_create(parent);',
    '    lv_obj_set_size(page, LV_PCT(100), LV_PCT(100));',
    '    lv_obj_set_flex_flow(page, LV_FLEX_FLOW_COLUMN);',
    '    lv_obj_set_flex_align(page, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);',
    '',
    '    lv_obj_t *title = lv_label_create(page);',
    `    lv_label_set_text(title, "${titleOf(name)}");`,
    '#if LV_USE_OBJ_NAME',
    '    lv_obj_set_name(title, "title");',
    '#endif',
    '',
    '    return page;',
    '}',
    '',
  ].join('\n');
}

function planCmake(text, sourceRel) {
  if (new RegExp(`"${sourceRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(text)) {
    return { ok: true, mode: 'listed', changed: false, text };
  }

  if (/\bSRC_DIRS\b/.test(text)) {
    return { ok: true, mode: 'src-dirs', changed: false, text };
  }

  const lines = splitLines(text);
  let srcsLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\bSRCS\b/.test(lines[i].text)) { srcsLine = i; break; }
  }
  if (srcsLine === -1) {
    return { ok: false, problem: 'CMakeLists.txt 里既没有 SRCS 也没有 SRC_DIRS，不知道新页面怎么参与编译' };
  }

  let last = -1;
  let indent = '    ';
  for (let i = srcsLine; i < lines.length; i++) {
    const trimmed = lines[i].text.trim();
    if (i > srcsLine && /^(?:INCLUDE_DIRS|REQUIRES|PRIV_REQUIRES|\))/.test(trimmed)) break;
    const match = lines[i].text.match(/^(\s*)"([^"]+\.c)"\s*$/);
    if (match) {
      last = i;
      indent = match[1];
    }
  }
  if (last === -1) {
    return { ok: false, problem: 'CMakeLists.txt 的 SRCS 不是每行一个 "文件.c"，无法安全插入新页面' };
  }

  return {
    ok: true,
    mode: 'srcs',
    changed: true,
    text: insertAfterLine(text, lines[last], `${indent}"${sourceRel}"`),
  };
}

function backupTable(root, tableFile, originalText) {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `${pad(now.getMilliseconds(), 3)}`;
  const dir = path.join(root, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });

  // Two edits in the same millisecond (tests) must not overwrite each other.
  let file = path.join(dir, `${path.basename(tableFile)}.${stamp}.bak`);
  for (let suffix = 1; fs.existsSync(file); suffix++) {
    file = path.join(dir, `${path.basename(tableFile)}.${stamp}-${suffix}.bak`);
  }
  fs.writeFileSync(file, originalText, 'utf8');
  return file;
}

/**
 * Add `name` as the last page of a template-style UI.
 *
 * @param {{root:string, uiDir:string}} ctx
 * @param {{name:string, dryRun?:boolean}} options
 * @returns {{ok:boolean, stage?:string, problems?:string[], ...}}
 */
export function newPage(ctx, { name, dryRun = false } = {}) {
  const root = typeof ctx?.root === 'string' && ctx.root !== '' ? path.resolve(ctx.root) : null;
  const uiDir = typeof ctx?.uiDir === 'string' && ctx.uiDir !== '' ? path.resolve(ctx.uiDir) : null;
  if (root === null || uiDir === null) return fail('ctx', ['未确定工程根目录或 UI 目录']);

  const relUiDir = path.relative(root, uiDir);
  if (relUiDir === '' || relUiDir === '..' || relUiDir.startsWith(`..${path.sep}`) || path.isAbsolute(relUiDir)) {
    return fail('ctx', [`UI 目录不在工程内：${uiDir}`]);
  }

  const page = typeof name === 'string' ? name.trim() : '';
  if (page === '') return fail('usage', ['需要一个页名：lvglui new <name>']);
  if (page.length > NAME_MAX) return fail('usage', [`页名最长 ${NAME_MAX} 个字符：${page}`]);
  if (!NAME_RE.test(page)) return fail('usage', [`页名必须是 snake_case（小写字母开头，只用 a-z、0-9、_）：${page}`]);
  if (C_KEYWORDS.has(page)) return fail('usage', [`页名与 C 关键字冲突：${page}`]);

  const tableFile = path.join(uiDir, 'src', 'ui_pages.c');
  if (!fs.existsSync(tableFile)) {
    return fail('usage', [
      `没有多页契约：${toPosix(path.relative(root, tableFile))} 不存在`,
      '单页工程不需要新增页；多页工程请先用 init 生成 ui_pages.c',
    ]);
  }

  const headerFile = path.join(uiDir, 'include', 'pages', `${page}.h`);
  const sourceFile = path.join(uiDir, 'src', 'pages', `${page}.c`);

  const originalText = readText(tableFile);
  if (originalText === null) return fail('io', [`读不到 ${tableFile}`]);

  const table = parseTable(originalText);
  if (!table.ok) return table;

  const names = new Set(table.entries.map((entry) => entry.name));
  if (names.has(page)) return fail('usage', [`页面表里已有 "${page}"`]);
  if (table.entries.some((entry) => entry.symbol === `ui_page_${page}_create`)) {
    return fail('usage', [`页面表里已有函数 ui_page_${page}_create`]);
  }
  if (originalText.includes(`#include "pages/${page}.h"`)) {
    return fail('usage', [`ui_pages.c 已 include "pages/${page}.h"`]);
  }

  if (fs.existsSync(headerFile) || fs.existsSync(sourceFile)) {
    return fail('usage', [`页面文件已存在：${toPosix(path.relative(root, fs.existsSync(headerFile) ? headerFile : sourceFile))}`]);
  }

  const cmakeFile = path.join(uiDir, 'CMakeLists.txt');
  const cmakeText = readText(cmakeFile);
  if (cmakeText === null) {
    return fail('usage', ['没有找到 UI 组件的 CMakeLists.txt，无法登记新页面']);
  }
  const cmakePlan = planCmake(cmakeText, `src/pages/${page}.c`);
  if (!cmakePlan.ok) return fail('usage', [cmakePlan.problem]);

  const lines = table.lines;
  const includeAnchor = findIncludeAnchor(lines);
  if (includeAnchor === -1) {
    return fail('usage', ['找不到 include 锚点（没有 "pages/*.h" 或 "ui_pages.h" 的 include）']);
  }

  const indent = table.entries.length > 0
    ? table.entries[table.entries.length - 1].indent
    : '    ';
  const includeLine = `#include "pages/${page}.h"`;
  const entryLine = `${indent}{ "${page}", ui_page_${page}_create },`;

  const withInclude = insertAfterLine(originalText, lines[includeAnchor], includeLine);
  const reparsed = parseTable(withInclude);
  if (!reparsed.ok) return reparsed;

  let nextText;
  if (reparsed.entries.length > 0) {
    const last = reparsed.entries[reparsed.entries.length - 1];
    nextText = insertEntryAfter(withInclude, reparsed.lines, last.line, entryLine);
  } else {
    const openerLine = reparsed.lines[reparsed.opener];
    nextText = insertAfterLine(withInclude, openerLine, entryLine);
  }
  if (typeof nextText !== 'string') {
    return fail('usage', ['页面表最后一行结构无法识别，已放弃（未改任何文件）']);
  }

  const verified = parseTable(nextText);
  if (!verified.ok
    || verified.entries.length !== table.entries.length + 1
    || !verified.entries.some((entry) => entry.name === page)
    || !nextText.includes(includeLine)) {
    return fail('usage', ['插入后的页面表校验失败，已放弃（未改任何文件）']);
  }

  const warnings = [];
  if (cmakePlan.mode === 'src-dirs' && !cmakeText.includes('src/pages')) {
    warnings.push('CMakeLists 用的是 SRC_DIRS，确认它包含 src/pages（新页面要参与编译）');
  }

  const rel = (file) => toPosix(path.relative(root, file));
  const result = {
    ok: true,
    stage: null,
    root,
    uiDir: toPosix(relUiDir),
    page,
    dryRun,
    files: {
      header: rel(headerFile),
      source: rel(sourceFile),
      table: rel(tableFile),
      cmake: rel(cmakeFile),
    },
    created: [rel(headerFile), rel(sourceFile)],
    updated: [rel(tableFile), ...(cmakePlan.changed ? [rel(cmakeFile)] : [])],
    backups: [],
    cmake: { mode: cmakePlan.mode, changed: cmakePlan.changed },
    pages: {
      before: table.entries.length,
      after: verified.entries.length,
      names: [...table.entries.map((entry) => entry.name), page],
    },
    warnings,
  };

  if (dryRun) return result;

  let backups = [];
  const createdNow = [];
  let cmakeWritten = false;
  try {
    backups.push(backupTable(root, tableFile, originalText));
    if (cmakePlan.changed) backups.push(backupTable(root, cmakeFile, cmakeText));
    result.backups = backups.map(rel);

    writeIfChanged(headerFile, pageHeader(page));
    createdNow.push(headerFile);
    writeIfChanged(sourceFile, pageSource(page));
    createdNow.push(sourceFile);

    if (cmakePlan.changed) {
      writeIfChanged(cmakeFile, cmakePlan.text);
      cmakeWritten = true;
      if (!(readText(cmakeFile) ?? '').includes(`"src/pages/${page}.c"`)) {
        throw new Error('CMakeLists.txt 写入后校验失败');
      }
    }

    writeIfChanged(tableFile, nextText);
    const after = parseTable(readText(tableFile) ?? '');
    if (!after.ok || after.entries.length !== verified.entries.length) {
      throw new Error('页面表写入后校验失败');
    }
  } catch (e) {
    try { if (cmakeWritten) writeIfChanged(cmakeFile, cmakeText); } catch { /* best-effort rollback */ }
    try { writeIfChanged(tableFile, originalText); } catch { /* best-effort rollback */ }
    for (const file of createdNow) {
      try { fs.unlinkSync(file); } catch { /* best-effort rollback */ }
    }
    for (const file of backups) {
      try { fs.unlinkSync(file); } catch { /* best-effort rollback */ }
    }
    return fail('io', [`新增页面失败，已回滚：${e.message}`]);
  }

  return result;
}