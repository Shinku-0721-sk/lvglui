// CLI 与 MCP server 共用的实现：探测工程 → 生成 lv_conf.h → 编译 → 渲染。
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRgb565Png } from '../core/png.mjs';
import { parseSdkconfig, writeLvConf } from '../core/kconfig.mjs';
import { detect } from './project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = path.resolve(HERE, '..');
export const OUT_DIR = path.join(TOOL_DIR, 'out');
const BUILD_BAT = path.join(TOOL_DIR, 'build-cli.bat');
const HOST_DIR = path.join(TOOL_DIR, 'host');

const VS_ROOT = 'D:\\Program Files\\Microsoft Visual Studio\\2022\\Community';
export const VCVARS = path.join(VS_ROOT, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');

const firstExisting = (candidates) => candidates.find((p) => p && existsSync(p)) || null;

function cmakeExe() {
  return process.env.LVGLUI_CMAKE
    || firstExisting(['E:\\Espressif\\tools\\cmake\\4.0.3\\bin\\cmake.exe',
                      'E:\\Espressif\\tools\\cmake\\3.24.0\\bin\\cmake.exe'])
    || 'cmake';
}

function ninjaExe() {
  return process.env.LVGLUI_NINJA
    || firstExisting(['E:\\Espressif\\tools\\ninja\\1.12.1\\ninja.exe',
                      'E:\\Espressif\\tools\\ninja\\1.11.1\\ninja.exe'])
    || 'ninja';
}

/** 每个工程一个独立的构建目录，互不踩踏：build/<工程名>-<路径哈希> */
function projectId(root) {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

/**
 * 探测工程并算好这次渲染要用到的所有路径。
 * 探测失败也返回对象（ok=false），好在 CLI 里打印一条人话错误。
 */
export function context(projectDir) {
  const start = projectDir ? path.resolve(projectDir) : process.cwd();
  const proj = detect(start, TOOL_DIR);
  if (!proj.ok) return { ...proj, buildDir: null };
  const buildDir = path.join(TOOL_DIR, 'build', projectId(proj.root));
  return { ...proj, buildDir, tmpDir: path.join(buildDir, 'tmp') };
}

/** sdkconfig 里有多少个 CONFIG_LV_*：0 说明这个工程压根没配过 LVGL */
function lvOptionCount(sdkconfig) {
  try {
    const kc = parseSdkconfig(sdkconfig);
    return [...kc.keys()].filter((k) => k.startsWith('LV_')).length;
  } catch {
    return 0;
  }
}

/** 预览靠控件名字做事（dump_names），固件没开 LV_USE_OBJ_NAME 就强制打开——只影响预览 */
const FORCE_NOTE = '/* 预览需要按名字找控件，固件没开 LV_USE_OBJ_NAME，这里强制打开（只影响预览） */\n#define LV_USE_OBJ_NAME 1';
const FORCE_TAG = '这里强制打开';
/** 预览靠控件名字做事，固件没开 LV_USE_OBJ_NAME 就在预览配置里强制打开（只在写文件时做一次） */
function forceObjNameText(text) {
  if (/^#define LV_USE_OBJ_NAME\s+1\s*$/m.test(text)) return text;
  return /^#define LV_USE_OBJ_NAME\s+0\s*$/m.test(text)
    ? text.replace(/^#define LV_USE_OBJ_NAME\s+0\s*$/m, FORCE_NOTE)
    : text.replace(/#endif \/\* LV_CONF_H \*\//, `${FORCE_NOTE}\n#endif /* LV_CONF_H */`);
}

/** 配置从哪来：工程配过 LVGL（有 CONFIG_LV_*）就跟着固件走，否则用工具内置默认 */
function prepareConf(ctx) {
  mkdirSync(ctx.buildDir, { recursive: true });
  const lvCount = ctx.sdkconfig ? lvOptionCount(ctx.sdkconfig) : 0;
  const file = path.join(HOST_DIR, 'lv_conf.h');
  if (ctx.sdkconfig && lvCount > 0) {
    const out = path.join(ctx.buildDir, 'lv_conf.h');
    const r = writeLvConf({ sdkconfig: ctx.sdkconfig, lvglDir: ctx.lvglDir, out, post: forceObjNameText });
    const forcedObjName = r.text.includes(FORCE_TAG);
    return { dir: ctx.buildDir, file: out, source: 'sdkconfig', detail: r, forcedObjName,
      why: forcedObjName ? '固件没开 CONFIG_LV_USE_OBJ_NAME，预览已强制打开（真机上按名字找控件会失败）' : null };
  }
  return { dir: HOST_DIR, file, source: 'default', detail: null, forcedObjName: false,
    why: ctx.sdkconfig ? '固件 sdkconfig 里没有任何 CONFIG_LV_* 选项（这个工程还没接过 LVGL），预览用内置默认配置' : '工程里没有 sdkconfig，预览用内置默认配置' };
}

/** 把这次探测的结果写成 CMake 预加载脚本（-C），避免在 cmd 里拼一长串 -D 引号 */
function writeCacheScript(ctx, confDir) {
  const q = (v) => `"${String(v).replace(/\\/g, '/')}"`;
  const text = [
    '# 由 lvglui 每次构建前自动生成，不要手改。',
    `set(LVGLUI_TOOL_DIR ${q(TOOL_DIR)} CACHE PATH "" FORCE)`,
    `set(LVGLUI_PROJECT_DIR ${q(ctx.root)} CACHE PATH "" FORCE)`,
    `set(LVGLUI_UI_DIR ${q(ctx.uiDir)} CACHE PATH "" FORCE)`,
    `set(LVGLUI_ENTRY "${ctx.entry}" CACHE STRING "" FORCE)`,
    `set(LVGLUI_LVGL_DIR ${q(ctx.lvglDir)} CACHE PATH "" FORCE)`,
    `set(LVGLUI_CONF_DIR ${q(confDir)} CACHE PATH "" FORCE)`,
    '',
  ].join('\n');
  // 同理：内容没变不落盘，免得白白改 mtime
  const file = path.join(ctx.buildDir, 'lvglui.cmake');
  let old = null;
  try { old = readFileSync(file, 'utf8'); } catch { /* 首次 */ }
  if (old !== text) writeFileSync(file, text, 'utf8');
}

/** MSVC 在 zh-CN Windows 上吐 GBK；先按 UTF-8 严格解码，失败再退回 GBK */
function decode(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function errorLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/error (C\d+|LNK\d+)|fatal error/i.test(line)) continue;
    const key = line.replace(/^.*?(?=\S*\.c\()/, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.trim());
    if (out.length >= 8) break;
  }
  return out;
}

/** 增量编译 LVGL + ui.dll + preview.exe + shot.exe */
export function build(ctx, { quiet = true } = {}) {
  if (!ctx.ok) return { ok: false, stage: 'detect', errors: ctx.problems.map((msg) => ({ msg })) };
  mkdirSync(ctx.tmpDir, { recursive: true });

  const conf = prepareConf(ctx);
  writeCacheScript(ctx, conf.dir);

  const t0 = Date.now();
  const r = spawnSync('cmd.exe', ['/c', BUILD_BAT], {
    cwd: TOOL_DIR,
    encoding: 'buffer',
    timeout: 900000,
    windowsHide: true,
    env: {
      ...process.env,
      LVGLUI_BUILD: ctx.buildDir,
      LVGLUI_TOOL: TOOL_DIR,
      LVGLUI_CMAKE: cmakeExe(),
      LVGLUI_NINJA: ninjaExe(),
      LVGLUI_VCVARS: VCVARS,
    },
  });
  const text = `${decode(r.stdout)}\n${decode(r.stderr)}`;
  const shot = path.join(ctx.buildDir, 'shot.exe');
  return {
    ok: r.status === 0 && existsSync(shot),
    ms: Date.now() - t0,
    status: r.status,
    config: conf.source,
    configNote: conf.why,
    errors: errorLines(text),
    log: quiet ? undefined : text,
  };
}

/** 无头渲染一帧，返回 PNG 路径与元数据 */
export function render(ctx, { out, frames = 12, rebuild = true } = {}) {
  if (!ctx.ok) return { ok: false, stage: 'detect', errors: ctx.problems.map((msg) => ({ msg })), png: null };
  const shot = path.join(ctx.buildDir, 'shot.exe');
  const pngPath = path.resolve(out || path.join(OUT_DIR, 'preview.png'));
  mkdirSync(path.dirname(pngPath), { recursive: true });

  const timings = {};
  let note = null;
  if (rebuild || !existsSync(shot)) {
    const b = build(ctx);
    note = b.configNote || null;
    timings.build = b.ms;
    if (!b.ok) {
      return {
        ok: false, stage: 'build', png: null, config: b.config, configNote: b.configNote,
        errors: b.errors.map((msg) => ({ msg })),
      };
    }
  } else {
    timings.build = 0;
  }

  const rawPath = path.join(ctx.buildDir, '.fb.bin');
  let t = Date.now();
  const r = spawnSync(shot, ['--raw', rawPath, '--frames', String(frames)], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  timings.shot = Date.now() - t;
  if (r.status !== 0 || !existsSync(rawPath)) {
    return {
      ok: false, stage: 'shot', png: null,
      errors: [{ msg: (r.stderr || r.stdout || 'shot.exe failed').trim() }],
    };
  }

  // LVGL 可能在我们那行帧描述之前打警告，所以取最后一条匹配
  const lines = String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => /^\d+ \d+ \d+ /.test(l));
  if (!hit) {
    return {
      ok: false, stage: 'shot', png: null,
      errors: [{ msg: `shot.exe 没有输出帧描述。stdout: ${lines.slice(-3).join(' | ')}` }],
    };
  }
  const [w, h, ver] = hit.split(/\s+/);
  const width = Number(w);
  const height = Number(h);
  const repaints = Number(ver);

  t = Date.now();
  const fb = readFileSync(rawPath);
  const png = encodeRgb565Png(fb, width, height);
  writeFileSync(pngPath, png);
  timings.encode = Date.now() - t;
  try { unlinkSync(rawPath); } catch { /* 尽力而为 */ }

  // 界面暴露了哪些名字：模型和人都需要知道这些
  const names = lines.filter((l) => l.startsWith('[ui] name ')).map((l) => l.slice(10).trim());

  return {
    ok: true,
    png: pngPath,
    width,
    height,
    bytes: png.length,
    repaints,
    timings,
    entry: ctx.entry,
    uiDir: ctx.uiDir,
    config: ctx.sdkconfig && lvOptionCount(ctx.sdkconfig) > 0 ? 'sdkconfig' : 'default',
    configNote: note,
    configWhy: ctx.sdkconfig && lvOptionCount(ctx.sdkconfig) === 0
      ? '固件 sdkconfig 里没有任何 CONFIG_LV_* 选项（这个工程还没接过 LVGL）'
      : (ctx.sdkconfig ? null : '工程里没有 sdkconfig'),
    names,
  };
}

/** 打开实时预览窗口（保存即重载） */
export function preview(ctx) {
  const exe = path.join(ctx.buildDir, 'preview.exe');
  if (!existsSync(exe)) {
    const b = build(ctx);
    if (!b.ok) return { ok: false, errors: b.errors.map((msg) => ({ msg })) };
  }
  const child = spawn(exe, [], { cwd: TOOL_DIR, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: child.pid !== undefined, exe, pid: child.pid };
}

/** 环境与工程自检 */
export function doctor(ctx) {
  return {
    ok: Boolean(ctx.ok && existsSync(VCVARS)),
    tool: {
      dir: TOOL_DIR,
      cmake: cmakeExe(),
      ninja: ninjaExe(),
      vcvars: { path: VCVARS, exists: existsSync(VCVARS) },
    },
    project: {
      ok: ctx.ok,
      root: ctx.root,
      uiDir: ctx.uiDir,
      sources: ctx.sources,
      entry: ctx.entry,
      entryHow: ctx.entryHow,
      configFile: ctx.configFile,
      lvglDir: ctx.lvglDir,
      sdkconfig: ctx.sdkconfig,
      configSource: ctx.sdkconfig ? 'sdkconfig' : 'default',
      buildDir: ctx.buildDir,
      problems: ctx.problems,
    },
  };
}