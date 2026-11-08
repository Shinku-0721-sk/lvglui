// sdkconfig → lv_conf.h 翻译器
//
// 目的：预览用的 LVGL 配置不再手写，而是从固件的 sdkconfig 直接翻译出来。
// 这样"预览和固件配置漂移"这类问题在结构上就不可能发生。
// （2026-11-08 的 "四个 f" 就是因为 PC 用 CLIB printf、固件用 builtin printf。）

import fs from 'node:fs';
import path from 'node:path';

const SET_RE = /^CONFIG_([A-Z0-9_]+)=(.*)$/;
const UNSET_RE = /^# CONFIG_([A-Z0-9_]+) is not set$/;

// 这些是 ESP-IDF 构建系统的开关，不是 lv_conf.h 的选项，翻译过去会炸
const BUILD_ONLY = new Set([
  'LV_CONF_SKIP',
  'LV_BUILD_EXAMPLES',
  'LV_BUILD_DEMOS',
  'LV_MEM_ADR',
]);

// LVGL 9.6 弃用了它，写进 lv_conf.h 会触发 #warning，MSVC 当致命错误
const DEPRECATED = new Set(['LV_COLOR_DEPTH']);

export function parseSdkconfig(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let m = line.match(SET_RE);
    if (m) { map.set(m[1], parseValue(m[2])); continue; }
    m = line.match(UNSET_RE);
    if (m) map.set(m[1], 0);
  }
  return map;
}

function parseValue(raw) {
  if (raw === 'y') return 1;
  if (raw === 'n') return 0;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

// 用 LVGL 自带的 lv_conf_template.h 当权威选项清单。
// 只认 "行首 #define LV_Xxx"（含被注释掉的），因为那才是"选项"；
// 像 LV_OS_CUSTOM / LV_STDLIB_CLIB 这类是枚举值，由 LVGL 自己定义。
// 一旦把它们也翻译过来，会出现 LV_USE_OS(0) == LV_OS_CUSTOM(0) 这种假相等，
// lv_conf_internal 就会去 #include 一个空文件名（2026-11-08 实际踩到）。
export function loadTemplateOptions(lvglDir) {
  const file = path.join(lvglDir, 'lv_conf_template.h');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const set = new Set();
  const re = /^[ \t]*(?:\/\/)?[ \t]*#define[ \t]+(LV_[A-Z0-9_]+)/gm;
  for (const m of text.matchAll(re)) set.add(m[1]);
  return set;
}

/**
 * @returns {{text: string, emitted: number, skippedBuild: string[], skippedUnknown: string[], droppedDeprecated: string[]}}
 */
export function translate(kconfig, templateSet) {
  const lines = [];
  const skippedBuild = [];
  const skippedUnknown = [];
  const droppedDeprecated = [];
  const droppedEmpty = [];

  for (const [name, value] of kconfig) {
    if (!name.startsWith('LV_')) continue;
    if (BUILD_ONLY.has(name)) { skippedBuild.push(name); continue; }
    if (DEPRECATED.has(name)) { droppedDeprecated.push(name); continue; }
    if (templateSet && !templateSet.has(name)) { skippedUnknown.push(name); continue; }
    // 空字符串选项（如 LV_ASSERT_HANDLER_INCLUDE=""）只要"被定义"就会触发
    // LVGL 的兼容层 #warning，而 MSVC 把 #warning 当致命错误 —— 空值等于没配，直接不写。
    if (value === '') { droppedEmpty.push(name); continue; }

    let v;
    if (typeof value === 'string') v = `"${value.replace(/"/g, '\\"')}"`;
    else if (value === 1) v = '1';
    else if (value === 0) v = '0';
    else v = String(value);

    lines.push(`#define ${name} ${v}`);
  }

  const body = lines.join('\n');
  const text =
`/* 自动生成，不要手改。来源：sdkconfig（ESP-IDF 固件配置）。
 * 由 tools/ui-preview/cli/kconfig.mjs 生成。
 * 手改会在下次渲染时被覆盖；要改配置请改 sdkconfig 或 lvglui.json。 */
#ifndef LV_CONF_H
#define LV_CONF_H

${body}

#endif /* LV_CONF_H */
`;
  return { text, emitted: lines.length, skippedBuild, skippedUnknown, droppedDeprecated, droppedEmpty };
}

export function writeLvConf({ sdkconfig, lvglDir, out, post }) {
  const kconfig = parseSdkconfig(sdkconfig);
  const templateSet = loadTemplateOptions(lvglDir);
  const res = translate(kconfig, templateSet);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 内容没变就不落盘：落盘会改 mtime，ninja 会认为 lv_conf.h 变了，
  // 于是 483 个 LVGL 文件全部重编，增量渲染从 2 秒退化到 11 秒。
  // post：写出前的最后加工（预览侧的强制开关）。必须在这里做：
  // 若先写基础版再补一行，mtime 每次都变，LVGL 483 个文件会全量重编。
  const text = post ? post(res.text) : res.text;
  let changed = true;
  try {
    changed = fs.readFileSync(out, 'utf8') !== text;
  } catch { /* 文件还不存在 */ }
  if (changed) fs.writeFileSync(out, text, 'utf8');
  return { ...res, text, out, changed };
}