// 工程探测：找到一个 ESP-IDF 工程里的「界面在哪、入口叫什么、LVGL 在哪」。
//
// 原则（docs/LVGLUI_V1_SPEC.md §4.1）：不按路径猜，按代码找。
//   1. lvglui.json 里写死的，最优先
//   2. 常见目录名：components/app_ui > components/ui > ui > src/ui
//   3. 全工程搜 lv_screen_load(xxx_create( )) 的调用点 —— 这是"真的在用"的证据
//   4. 搜 lv_obj_t * xxx_create(lv_obj_t * 的定义
//   5. 都没有 → 报错，告诉用户跑 `lvglui init`
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** 扫描时跳过的目录：构建产物、依赖、设计稿、工具自己的东西 */
const SKIP = new Set([
  'build', 'node_modules', '.git', '.lvglui', 'managed_components',
  'design', 'out', 'tmp', '.vscode', 'dist', '.cache',
]);

const COMMON_UI_DIRS = [
  'components/app_ui',
  'components/app-ui',
  'components/ui',
  'components/UI',
  'ui',
  'src/ui',
  'main/ui',
];

/** 从 startDir 往上找带 project() 的 CMakeLists.txt；skipDir（工具自己）不算工程根 */
export function findProjectRoot(startDir, skipDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const isTool = skipDir && (dir === skipDir || dir.startsWith(skipDir + path.sep));
    if (!isTool) {
      const cm = path.join(dir, 'CMakeLists.txt');
      if (existsSync(cm)) {
        try {
          const text = readFileSync(cm, 'utf8');
          if (/^[ \t]*project[ \t]*\(/m.test(text)) return dir;
        } catch { /* 读不了就当没有 */ }
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function walkSources(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walkSources(full, out, depth + 1);
    } else if (/\.(c|h)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 读 lvglui.json（可选的配置文件，没有就是空对象） */
export function readConfig(root) {
  const file = path.join(root, 'lvglui.json');
  if (!existsSync(file)) return { file: null, data: {} };
  try {
    return { file, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { file, data: {}, error: `lvglui.json 解析失败: ${e.message}` };
  }
}

/** 目录里有没有 .c 文件（空目录不算界面目录） */
function hasSources(dir) {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith('.c'));
  } catch { return false; }
}

/** 搜全工程里 `lv_screen_load(xxx_create(` 的调用点 → 界面入口名 */
function entryFromCallSites(files) {
  const re = /lv_(?:screen|scr)_load[ \t]*\([ \t]*([A-Za-z_]\w*)[ \t]*\(/g;
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let m;
    while ((m = re.exec(text)) !== null) {
      return { name: m[1], file, how: 'call-site' };
    }
  }
  return null;
}

/** 搜 `lv_obj_t * xxx_create(lv_obj_t * parent)` / `xxx_create(void)` 的定义 */
function entryFromDefinitions(files) {
  // lv_obj_t * xxx_create(lv_obj_t * parent)  /  xxx_create(void)
  const re = /lv_obj_t[ \t]*\*[ \t]*([A-Za-z_]\w*)[ \t]*\([ \t]*(?:lv_obj_t[ \t]*\*[ \t]*\w*|void)[ \t]*\)/g;
  const names = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let m;
    while ((m = re.exec(text)) !== null) names.push({ name: m[1], file });
  }
  return names;
}

/**
 * 探测整个工程。
 * @returns {{ok:boolean, root:string, uiDir:string|null, entry:string|null,
 *            entryHow:string, lvglDir:string|null, sdkconfig:string|null,
 *            configFile:string|null, sources:string[], problems:string[]}}
 */
export function detect(startDir, toolRoot) {
  const problems = [];
  const root = findProjectRoot(startDir, toolRoot);
  if (!root) {
    return {
      ok: false, root: path.resolve(startDir), uiDir: null, entry: null, entryHow: null,
      lvglDir: null, sdkconfig: null, configFile: null, sources: [],
      problems: [`从 ${startDir} 往上找不到 ESP-IDF 工程（带 project() 的 CMakeLists.txt）`],
    };
  }

  const cfg = readConfig(root);
  if (cfg.error) problems.push(cfg.error);
  const conf = cfg.data || {};

  // ---- 1. 界面目录 ----
  let uiDir = null;
  let entry = null;
  let entryHow = null;

  if (conf.uiDir) {
    const p = path.resolve(root, conf.uiDir);
    if (hasSources(p)) { uiDir = p; entryHow = 'lvglui.json'; }
    else problems.push(`lvglui.json 里的 uiDir 不存在或没有 .c：${conf.uiDir}`);
  }

  const allSources = walkSources(root);

  if (!uiDir) {
    for (const rel of COMMON_UI_DIRS) {
      const p = path.join(root, rel);
      if (hasSources(p)) { uiDir = p; entryHow = 'common-dir'; break; }
    }
  }

  // ---- 2. 入口函数 ----
  if (conf.entry) {
    entry = conf.entry;
    entryHow = 'lvglui.json';
  }

  const callSite = entryFromCallSites(allSources);
  if (!entry && callSite) {
    entry = callSite.name;
    entryHow = 'call-site';
    // 调用点在业务代码里，界面目录还没找到 → 用入口名反查它的定义在哪
  }

  if (!uiDir && callSite) {
    const defs = entryFromDefinitions(allSources);
    const hit = defs.find((d) => d.name === entry);
    if (hit) { uiDir = path.dirname(hit.file); entryHow = entryHow || 'definition-dir'; }
  }

  if (!uiDir) {
    const defs = entryFromDefinitions(allSources);
    if (defs.length) { uiDir = path.dirname(defs[0].file); entryHow = 'definition-dir'; }
    if (!entry && defs.length) { entry = defs[0].name; entryHow = 'definition'; }
  }

  // 界面目录先按目录名找到了、但没人调用它 → 在界面目录里找 xxx_create 的定义
  if (!entry && uiDir) {
    const local = readdirSync(uiDir)
      .filter((f) => f.endsWith('.c'))
      .map((f) => path.join(uiDir, f));
    const defs = entryFromDefinitions(local);
    if (defs.length) { entry = defs[0].name; entryHow = 'definition'; }
  }

  if (!uiDir) problems.push('找不到界面源码目录（试过 components/app_ui、ui/、按代码反查）');
  if (!entry) problems.push('找不到界面入口函数（形如 lv_obj_t * home_create(lv_obj_t *)）');

  // ---- 3. LVGL 源码 ----
  const lvglCandidates = [
    path.join(root, 'managed_components', 'lvgl__lvgl'),
    path.join(root, 'components', 'lvgl'),
    path.join(toolRoot, 'vendor', 'lvgl'),
  ];
  const lvglDir = lvglCandidates.find((p) => existsSync(path.join(p, 'include', 'lvgl', 'lvgl.h'))) || null;
  if (!lvglDir) {
    problems.push('找不到 LVGL 源码（找过 managed_components/lvgl__lvgl、components/lvgl、工具自带 vendor/lvgl）');
  }

  const sdkconfig = existsSync(path.join(root, 'sdkconfig')) ? path.join(root, 'sdkconfig') : null;

  const sources = uiDir ? readdirSync(uiDir).filter((f) => f.endsWith('.c')).map((f) => path.join(uiDir, f)) : [];

  return {
    ok: Boolean(uiDir && entry && lvglDir),
    root,
    uiDir,
    entry,
    entryHow,
    lvglDir,
    sdkconfig,
    configFile: cfg.file,
    sources,
    problems,
  };
}