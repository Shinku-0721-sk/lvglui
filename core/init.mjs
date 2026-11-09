// `init`: create the UI component from `ui-template/` and write the project
// config. Validation happens before the first write, so a rejected init leaves
// the target project untouched. v1 never overwrites: `force` is accepted for
// the CLI/MCP contract but has no effect here.

import fs from 'node:fs';
import path from 'node:path';

import { DISPLAY_MAX, DISPLAY_MIN } from './config.mjs';

const CONFIG_FILE = 'lvglui.json';
const TEMPLATE_DIR = 'ui-template';
const DEFAULT_UI_DIR = 'components/app_ui';
const LVGL_COMPONENT_TOKEN = '__LVGL_COMPONENT__';
const CONFIG_EXISTS_PROBLEM = 'lvglui.json 已存在；init 不会覆盖';

// Copy order is also the order of the returned `created` list.
const TEMPLATE_FILES = [
  'CMakeLists.txt',
  'include/ui.h',
  'include/ui_port.h',
  'include/ui_theme.h',
  'include/ui_pages.h',
  'include/pages/home.h',
  'src/ui.c',
  'src/ui_pages.c',
  'src/ui_theme.c',
  'src/ui_port_stub.c',
  'src/pages/home.c',
];

// Text a business project pastes after LVGL/display bring-up. Kept byte-stable
// because the CLI and MCP print it verbatim.
const SNIPPET = [
  '#include "ui.h"',
  '',
  '/* 放在 LVGL 显示/触摸初始化完成之后 */',
  'ui_start(NULL);',
  '',
].join('\n');

function isDisplayDimension(value) {
  return Number.isInteger(value) && value >= DISPLAY_MIN && value <= DISPLAY_MAX;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function show(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw new Error(`failed to inspect ${target}: ${e.message}`);
  }
}

// `rel` is inside `root` when it is neither the root itself nor an escape.
function insideRoot(rel) {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Walk every existing segment below `rootAbs`; a junction/symlink ancestor
// would redirect mkdir/copy outside the project even though the lexical
// relative path looks contained. Windows junctions are symlinks to lstat.
function findLinkedSegment(rootAbs, targetAbs) {
  const rel = path.relative(rootAbs, targetAbs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  let current = rootAbs;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw new Error(`failed to inspect ${current}: ${e.message}`);
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

// Recursive .c scan, symlinks skipped so a link loop cannot hang init. Any
// unreadable directory is an error: silently skipping it could hide an
// existing UI implementation.
function findCFiles(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      throw new Error(`failed to scan ${current}: ${e.message}`);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.c') found.push(full);
    }
  }
  return found.sort();
}

// Config paths are relative when they stay under the project root, absolute
// otherwise. Always emitted with forward slashes so lvglui.json does not
// contain doubled JSON backslashes.
function configPath(rootAbs, value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const abs = path.resolve(rootAbs, value);
  const rel = path.relative(rootAbs, abs);
  if (rel === '') return '.';
  return toPosix(insideRoot(rel) ? rel : abs);
}

function buildConfig({ rootAbs, uiDir, width, height, idfPath, lvglDir }) {
  const config = { schema: 1 };
  const idf = configPath(rootAbs, idfPath);
  if (idf !== null) config.idfPath = idf;
  const lvgl = configPath(rootAbs, lvglDir);
  if (lvgl !== null) config.lvglDir = lvgl;
  config.uiDir = uiDir;
  config.entry = 'ui_start';
  config.display = { width, height, colorDepth: 16 };
  config.build = { dir: '.lvglui/build' };
  config.font = { mode: 'off', dynamic: 'labels', file: '', size: 16, name: '', cjk: false, fsPath: '', freetypeDir: '' };
  return config;
}

/**
 * The C snippet a target project needs after its display/LVGL init.
 * `config` is accepted for interface symmetry; v1 always calls the default
 * entry (`ui_start`) with NULL.
 */
export function integrationSnippet(config) {
  void config;
  return SNIPPET;
}

/**
 * Create `<root>/<uiDir>/**` from `ui-template/` and `<root>/lvglui.json`.
 *
 * @param {object} ctx project context (`root`, `uiDir`, `config`, `idf`, `lvgl`, `display`)
 * @param {object} [options]
 * @param {number} [options.width] display width override
 * @param {number} [options.height] display height override
 * @param {boolean} [options.force] accepted but ignored; v1 never overwrites
 * @returns {{ok:boolean, created:string[], configFile:string|null,
 *   snippet:string, problems:string[]}}
 */
export function initProject(ctx, { width, height, force = false } = {}) {
  void force;

  const created = [];
  const problems = [];

  const fail = () => ({
    ok: false,
    created: [...created],
    configFile: null,
    snippet: '',
    problems: [...new Set(problems)],
  });

  try {
    if (ctx === null || typeof ctx !== 'object') {
      problems.push('initProject 需要项目 ctx');
      return fail();
    }

    const rootAbs = path.resolve(typeof ctx.root === 'string' && ctx.root !== '' ? ctx.root : '.');
    const configFile = path.join(rootAbs, CONFIG_FILE);

    if (statOrNull(configFile) !== null) {
      problems.push(CONFIG_EXISTS_PROBLEM);
    }

    // ---- Display: args first, then the detected display. No 240x320 default.
    const display = ctx.display !== null && typeof ctx.display === 'object' ? ctx.display : {};
    const resolvedWidth = width ?? display.width;
    const resolvedHeight = height ?? display.height;
    if (!isDisplayDimension(resolvedWidth) || !isDisplayDimension(resolvedHeight)) {
      problems.push(
        `width/height 必须是 ${DISPLAY_MIN}..${DISPLAY_MAX} 的整数，来自 --width/--height 或 ctx.display；` +
          `收到 width=${show(resolvedWidth)}, height=${show(resolvedHeight)}；init 不会默认 240x320`,
      );
    }

    // ---- Template directory (the checkout that owns this module).
    const toolDir = path.resolve(
      isNonEmptyString(ctx.toolDir) ? ctx.toolDir : path.join(import.meta.dirname, '..'),
    );
    const templateDir = path.join(toolDir, TEMPLATE_DIR);
    const templateSources = new Map();
    for (const rel of TEMPLATE_FILES) {
      const source = path.join(templateDir, rel);
      if (statOrNull(source) === null) problems.push(`UI 模板缺失: ${source}`);
      else templateSources.set(rel, source);
    }

    // ---- LVGL component name: the CMake component is the directory basename
    // (`lvgl__lvgl` for managed_components, `lvgl` for components/lvgl).
    const lvglDirValue = ctx.lvgl?.dir;
    const lvglDir = isNonEmptyString(lvglDirValue) ? lvglDirValue : null;
    const componentName = lvglDir === null ? null : path.basename(path.resolve(rootAbs, lvglDir));
    if (componentName === null || componentName === '') {
      problems.push('ctx.lvgl.dir 未设置；无法确定 UI 组件的 REQUIRES 名称（init 未写入任何文件）');
    }

    // ---- Target directory: config.uiDir, then ctx.uiDir, then the default.
    const configuredUiDir = isNonEmptyString(ctx.config?.uiDir) ? ctx.config.uiDir : null;
    const contextUiDir = isNonEmptyString(ctx.uiDir) ? ctx.uiDir : null;
    const uiDirSpec = configuredUiDir ?? contextUiDir ?? DEFAULT_UI_DIR;
    const targetAbs = path.resolve(rootAbs, uiDirSpec);
    const relTarget = path.relative(rootAbs, targetAbs);

    if (!insideRoot(relTarget)) {
      problems.push(`uiDir 必须位于工程根内: "${uiDirSpec}" (${targetAbs})`);
    } else {
      const linked = findLinkedSegment(rootAbs, targetAbs);
      if (linked !== null) {
        problems.push(
          `uiDir 路径包含符号链接，拒绝写入: ${toPosix(path.relative(rootAbs, linked))} (${targetAbs})`,
        );
      } else {
        const targetStat = statOrNull(targetAbs);
        if (targetStat !== null && !targetStat.isDirectory()) {
          problems.push(`uiDir 已存在且不是目录，拒绝覆盖: ${targetAbs}`);
        } else if (targetStat !== null) {
          const existingC = findCFiles(targetAbs);
          if (existingC.length > 0) {
            const first = toPosix(path.relative(rootAbs, existingC[0]));
            problems.push(
              `uiDir 已存在且包含 .c 文件，拒绝覆盖: ${first}` +
                (existingC.length > 1 ? ` (等共 ${existingC.length} 个)` : ''),
            );
          }
          for (const rel of TEMPLATE_FILES) {
            const dest = path.join(targetAbs, rel);
            if (statOrNull(dest) !== null) {
              problems.push(`目标文件已存在，拒绝覆盖: ${toPosix(path.relative(rootAbs, dest))}`);
            }
          }
        }
      }
    }

    if (problems.length > 0) return fail();

    // ---- Write. Validation is complete; failures here may leave partial
    // output, which the catch reports together with the files already written.
    fs.mkdirSync(targetAbs, { recursive: true });
    for (const rel of TEMPLATE_FILES) {
      const source = templateSources.get(rel);
      const dest = path.join(targetAbs, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (rel === 'CMakeLists.txt') {
        const text = fs.readFileSync(source, 'utf8').replaceAll(LVGL_COMPONENT_TOKEN, componentName);
        if (text.includes(LVGL_COMPONENT_TOKEN)) {
          throw new Error(`failed to substitute ${LVGL_COMPONENT_TOKEN} in ${source}`);
        }
        fs.writeFileSync(dest, text, { flag: 'wx' });
      } else {
        fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      }
      created.push(toPosix(path.relative(rootAbs, dest)));
    }

    const config = buildConfig({
      rootAbs,
      uiDir: toPosix(relTarget),
      width: resolvedWidth,
      height: resolvedHeight,
      idfPath: ctx.idf?.path,
      lvglDir,
    });
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });

    return {
      ok: true,
      created,
      configFile,
      snippet: integrationSnippet(config),
      problems: [],
    };
  } catch (e) {
    problems.push(`init 失败: ${e.message}`);
    return fail();
  }
}
