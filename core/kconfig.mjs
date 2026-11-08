// sdkconfig → lv_conf.h 翻译器
//
// 目的：预览用的 LVGL 配置不再手写，而是从固件的 sdkconfig 直接翻译出来。
// 这样"预览和固件配置漂移"这类问题在结构上就不可能发生。
// （2026-11-08 的 "四个 f" 就是因为 PC 用 CLIB printf、固件用 builtin printf。）

import fs from 'node:fs';
import path from 'node:path';
import { writeIfChanged } from './fsutil.mjs';

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

/**
 * 预览构建的确定性覆盖表。LVGL 9 没有 LV_COLOR_DEPTH，只认
 * LV_COLOR_FORMAT_*；对象名、CJK 字体、主题、flex/grid 都是预览必需，
 * 不能依赖固件 sdkconfig 里恰好开了它们。
 *
 * 数值是 C token / 数字，逐字写入（不是带引号的 JS 字符串）。
 */
export const DEFAULT_OVERRIDES = {
  LV_COLOR_FORMAT_DEFAULT: 'LV_COLOR_FORMAT_RGB565',
  LV_USE_OBJ_NAME: '1',
  LV_FONT_MONTSERRAT_14: '1',
  LV_FONT_MONTSERRAT_16: '1',
  LV_FONT_SOURCE_HAN_SANS_SC_14_CJK: '1',
  LV_FONT_SOURCE_HAN_SANS_SC_16_CJK: '1',
  LV_USE_THEME_SIMPLE: '1',
  LV_USE_THEME_DEFAULT: '1',
  LV_USE_FLEX: '1',
  LV_USE_GRID: '1',
};

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

export function parseValue(raw) {
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
 * 把 sdkconfig 选项翻译成 lv_conf.h 的 #define 行。
 * @param {Map<string, string|number>} kconfig `parseSdkconfig` 的结果（必须是 Map）
 * @param {Set<string>|null} templateSet `loadTemplateOptions` 的结果；null 表示不筛未知项
 * @returns {{text: string, emitted: number, skippedBuild: string[], skippedUnknown: string[], droppedDeprecated: string[], droppedEmpty: string[]}}
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
 * 由 lvglui/core/kconfig.mjs 生成。
 * 手改会在下次渲染时被覆盖；要改配置请改 sdkconfig 或 lvglui.json。 */
#ifndef LV_CONF_H
#define LV_CONF_H

${body}

#endif /* LV_CONF_H */
`;
  return { text, emitted: lines.length, skippedBuild, skippedUnknown, droppedDeprecated, droppedEmpty };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 在已翻译出的 lv_conf.h 文本上应用覆盖表。
 *
 * - 已存在的 `#define KEY ...` 行就地替换（所有出现处都替换，保留其余字节）。
 * - 缺失的键追加到 `LV_CONF_H` 守卫内部、末尾的 `#endif` 标记之前，
 *   写成 `#ifndef KEY / #define KEY value / #endif`；找不到标记则追加到末尾。
 * - 每个键最多产生一个 `#define`，不会重复。
 *
 * @param {string} text
 * @param {Record<string, string>} overrides 值逐字写入，必须是 C token / 数字
 * @returns {string}
 */
export function applyOverrides(text, overrides = {}) {
  let out = text;
  const missing = [];

  for (const [key, value] of Object.entries(overrides)) {
    const escaped = escapeRegExp(key);
    if (new RegExp(`^#define\\s+${escaped}\\s+.*$`, 'm').test(out)) {
      out = out.replace(
        new RegExp(`^#define\\s+${escaped}\\s+.*$`, 'gm'),
        () => `#define ${key} ${value}`,
      );
    } else {
      missing.push([key, value]);
    }
  }

  if (missing.length === 0) return out;

  const block = missing
    .map(([key, value]) => `#ifndef ${key}\n#define ${key} ${value}\n#endif`)
    .join('\n\n');
  const marker = '#endif /* LV_CONF_H */';
  const at = out.lastIndexOf(marker);
  if (at === -1) {
    const lead = out === '' || out.endsWith('\n') ? '' : '\n';
    return `${out}${lead}${block}\n`;
  }
  const before = out.slice(0, at);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  return `${before}${lead}${block}\n${out.slice(at)}`;
}

/**
 * 生成并写出 lv_conf.h。
 *
 * 顺序固定为 translate → applyOverrides → post。`overrides` 默认是
 * `DEFAULT_OVERRIDES`；传入自定义对象时是**替换**而不是合并默认表。
 * 内容与现有文件逐字节相同时不写盘（mtime 不变），否则 ninja 会把
 * LVGL 的几百个文件全部重编。`post` 的加工也必须在落盘判定之前完成，
 * 否则每次都会写出新内容、mtime 每次都变。
 *
 * @param {object} options
 * @param {string} options.sdkconfig 工程 sdkconfig 路径
 * @param {string} options.lvglDir LVGL 目录（含 lv_conf_template.h）
 * @param {string} options.out 生成的 lv_conf.h 路径
 * @param {(text: string) => string} [options.post] 覆盖之后的最后加工
 * @param {Record<string, string>} [options.overrides]
 * @returns {{text: string, emitted: number, skippedBuild: string[], skippedUnknown: string[], droppedDeprecated: string[], droppedEmpty: string[], out: string, changed: boolean, written: boolean}}
 */
export function writeLvConf({
  sdkconfig, lvglDir, out, post, overrides = DEFAULT_OVERRIDES,
}) {
  const kconfig = parseSdkconfig(sdkconfig);
  const templateSet = loadTemplateOptions(lvglDir);
  const res = translate(kconfig, templateSet);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const withOverrides = applyOverrides(res.text, overrides);
  const text = post ? post(withOverrides) : withOverrides;
  const { changed } = writeIfChanged(out, text);
  return { ...res, text, out, changed, written: changed };
}