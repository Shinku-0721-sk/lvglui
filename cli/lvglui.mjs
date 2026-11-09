#!/usr/bin/env node
// lvglui —— 用 C 写的 LVGL 界面，在 PC 上无头渲染成图 / 实时预览。
//
// 所有工程探测都交给 core/context.mjs（loadContext）；本文件只做参数解析、
// 命令编排、退出码和文本/JSON 输出，不复制核心逻辑。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadContext } from '../core/context.mjs';
import { renderProject } from '../core/render.mjs';
import { findToolchain } from '../core/toolchain.mjs';
import { doctor } from '../core/doctor.mjs';
import { buildHost, writeBuildScript } from '../core/build.mjs';
import { previewProject } from '../core/preview.mjs';
import { initProject } from '../core/init.mjs';
import { fontAdd, fontOff, fontStatus, FONT_PRESET, FONT_SIZE_MIN, FONT_SIZE_MAX } from '../core/font.mjs';
import { parseDiagnostics } from '../core/diagnostics.mjs';
import { DISPLAY_MAX, DISPLAY_MIN } from '../core/config.mjs';

const TOOL_DIR = path.resolve(import.meta.dirname, '..');

const COMMANDS = new Set([
  'render',
  'build',
  'watch',
  'serve',
  'preview',
  'init',
  'doctor',
  'dsh install',
  'font off',
  'font add',
  'font status',
  'help',
]);

const VALUE_FLAGS = new Set(['project', 'width', 'height', 'frames', 'out', 'port', 'preset', 'size', 'chars', 'name', 'font', 'dynamic']);
const NUMBER_FLAGS = new Set(['width', 'height', 'frames', 'port', 'size']);
const KNOWN_FLAGS = new Set([
  'project',
  'width',
  'height',
  'frames',
  'out',
  'port',
  'json',
  'force',
  'noBuild',
  'noRender',
  'preset',
  'size',
  'chars',
  'name',
  'font',
  'dynamic',
  'help',
]);

const FRAMES_MAX = 10000;
const PORT_MAX = 65535;

const USAGE = `lvglui —— LVGL UI 无头渲染 / 预览工具

用法:
  node cli/lvglui.mjs <command> [options]

命令:
  render       渲染当前界面到 <project>/.lvglui/out（默认命令）
  build        只编译 host 渲染器
  watch        监听 UI 源码变化并持续重渲
  serve        启动 HTTP 预览（127.0.0.1:8765，端口占用时自动 +1）
  preview      打开实时预览窗口
  init         在现有 ESP-IDF 工程中创建 UI 组件
  doctor       检查工程 / 工具链 / 显示配置
  font add     生成工程字体子集（默认 tools 内置 Noto Sans SC）
  font off     移除生成的字体与 theme 接入
  font status  查看字体模式与缺字
  dsh install  生成 DeepSeek Harness 插件（当前版本可用）
  help         显示本帮助

选项:
  --project <dir>   工程目录（默认 LVGLUI_PROJECT 或当前目录）
  --width <n>       显示宽度（工程未配置 display 时必填，不会默认 240x320）
  --height <n>      显示高度
  --frames <n>      渲染帧数（默认 12）
  --out <dir>       渲染输出目录（默认 <project>/.lvglui/out）
  --no-build        渲染时跳过编译，直接复用已有 shot.exe
  --json            render / build / doctor 只向 stdout 输出结果 JSON，日志走 stderr
  --force           init 兼容参数（v1 不覆盖已有文件）
  --no-render       init 后不做空白页渲染
  --port <n>        serve 起始端口（默认 8765）
  --preset <name>   font add 字体预设（noto-sans-sc）
  --size <n>        font add 字号（8..64，默认 16）
  --chars <text>    font add 额外字符
  --dynamic <mode>  font add 字符集：labels（默认）或 common（GB2312 一级 3755 常用字）
  --name <id>       font add 生成的 C 符号名
  --font <path>     font add 自定义 TTF/OTF（与 --preset 二选一）

退出码: 0 成功；1 构建/渲染失败；2 用法或配置错误；3 运行时/IO 错误`;

function camelCase(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

/**
 * Parse argv without touching the filesystem or environment beyond the
 * documented LVGLUI_PROJECT default.
 *
 * @param {string[]} argv
 * @returns {{command:string, flags:object, positionals:string[]}}
 */
export function parseArgs(argv = []) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    let key = arg.slice(2);
    let inline;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      inline = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key === '') continue;

    let value = inline;
    if (value === undefined && VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        value = next;
        i++;
      }
    }

    const name = camelCase(key);
    if (VALUE_FLAGS.has(key)) {
      flags[name] = value === undefined
        ? true
        : NUMBER_FLAGS.has(key)
          ? Number(value)
          : value;
    } else {
      flags[name] = value === undefined ? true : value;
    }
  }

  let command = positionals.shift() ?? 'render';
  if (command === 'dsh') {
    const sub = positionals.shift();
    if (sub === 'install') command = 'dsh install';
    else if (sub !== undefined) {
      positionals.unshift(sub);
      command = 'dsh';
    }
  }
  if (command === 'font') {
    const sub = positionals.shift();
    if (sub === 'off' || sub === 'add' || sub === 'status') command = `font ${sub}`;
    else if (sub !== undefined) {
      positionals.unshift(sub);
      command = 'font';
    }
  }

  if (flags.project === undefined) {
    flags.project = process.env.LVGLUI_PROJECT || process.cwd();
  }
  if (flags.help === true) command = 'help';

  return { command, flags, positionals };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// renderProject keeps the PNG Buffer and the parsed tree for programmatic
// callers; neither belongs in a CLI JSON line (the Buffer alone is megabytes).
function renderResult(result) {
  const copy = { ...result };
  delete copy.png;
  delete copy.tree;
  return copy;
}

function exitForRender(result) {
  switch (result.error?.stage) {
    case 'build':
      return 1;
    case 'ctx':
    case 'toolchain':
      return 2;
    default:
      return 3;
  }
}

function printDiagnostics(diagnostics) {
  for (const entry of diagnostics?.errors ?? []) {
    const location = entry.file
      ? `${entry.file}${entry.line ? `:${entry.line}` : ''}`
      : '';
    const code = entry.code ? ` ${entry.code}` : '';
    console.error(`[lvglui] ${location ? `${location} ` : ''}${entry.severity ?? 'error'}${code}: ${entry.message}`);
  }
  for (const hint of diagnostics?.hints ?? []) {
    console.error(`[lvglui] hint: ${hint}`);
  }
}

function reportRenderFailure(result) {
  const stage = result.error?.stage ?? 'unknown';
  console.error(`[lvglui] render failed (${stage}): ${result.error?.message ?? 'unknown error'}`);
  if (result.error?.buildLog) console.error(`[lvglui] build log: ${result.error.buildLog}`);
  printDiagnostics(result.diagnostics);
}

function loadFor(command, flags) {
  return loadContext({
    startDir: process.cwd(),
    projectDir: flags.project,
    cliWidth: flags.width,
    cliHeight: flags.height,
    requireUi: command !== 'init',
  });
}

function reportContextFailure(ctx, json) {
  const problems = ctx.problems?.length > 0 ? ctx.problems : ['工程上下文无效'];
  for (const problem of problems) console.error(`[lvglui] ${problem}`);
  if (json) {
    writeJson({ ok: false, stage: 'ctx', root: ctx.root ?? null, problems });
  }
  return 2;
}

function printChecks(checks, { json = false } = {}) {
  for (const check of checks) {
    if (json && check.status !== 'fail') continue;
    const line = `[${check.status}] ${check.id}: ${check.message}`;
    if (check.status === 'fail') console.error(line);
    else console.log(line);
    if (check.detail && !json) console.log(`       ${check.detail}`);
  }
}

function findToolchainFor(ctx) {
  try {
    return findToolchain({
      root: ctx.root,
      config: ctx.config,
      idf: ctx.idf,
      env: process.env,
    });
  } catch (e) {
    return { ok: false, problems: [`toolchain discovery failed: ${e.message}`] };
  }
}

function toolchainPaths(toolchain) {
  return { vcvars: toolchain.vcvars, cmake: toolchain.cmake, ninja: toolchain.ninja };
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validationProblem(command, flags, positionals) {
  if (!COMMANDS.has(command)) return `未知命令: ${command}`;
  if (command === 'help') return null;

  for (const key of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(key)) return `未知选项: --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  }
  if (positionals.length > 0) {
    if (command === 'dsh install') return `dsh install 不接受额外参数: ${positionals.join(' ')}`;
    if (command === 'font add') {
      if (positionals.length > 1) return `font add 最多接受一个字体路径: ${positionals.join(' ')}`;
    } else if (command.startsWith('font ')) {
      return `${command} 不接受额外参数: ${positionals.join(' ')}`;
    } else {
      return `多余的参数: ${positionals.join(' ')}`;
    }
  }
  if (command === 'font add') {
    if (flags.font !== undefined && flags.preset !== undefined) {
      return '--font 与 --preset 不能同时使用';
    }
    if (flags.size !== undefined
      && (!Number.isInteger(flags.size) || flags.size < FONT_SIZE_MIN || flags.size > FONT_SIZE_MAX)) {
      return `--size 必须是 ${FONT_SIZE_MIN}..${FONT_SIZE_MAX} 的整数`;
    }
  }
  if (typeof flags.project !== 'string' || flags.project.trim() === '') {
    return '--project 需要一个目录路径';
  }
  if (flags.out !== undefined && (typeof flags.out !== 'string' || flags.out.trim() === '')) {
    return '--out 需要一个输出目录';
  }
  if (flags.width !== undefined
    && (!Number.isInteger(flags.width) || flags.width < DISPLAY_MIN || flags.width > DISPLAY_MAX)) {
    return `--width 必须是 ${DISPLAY_MIN}..${DISPLAY_MAX} 的整数`;
  }
  if (flags.height !== undefined
    && (!Number.isInteger(flags.height) || flags.height < DISPLAY_MIN || flags.height > DISPLAY_MAX)) {
    return `--height 必须是 ${DISPLAY_MIN}..${DISPLAY_MAX} 的整数`;
  }
  if (flags.frames !== undefined
    && (!isPositiveInteger(flags.frames) || flags.frames > FRAMES_MAX)) {
    return `--frames 必须是 1..${FRAMES_MAX} 的整数`;
  }
  if (flags.port !== undefined
    && (!isPositiveInteger(flags.port) || flags.port > PORT_MAX)) {
    return `--port 必须是 1..${PORT_MAX} 的整数`;
  }
  return null;
}

async function runRender(flags) {
  const ctx = loadFor('render', flags);
  if (!ctx.ok) return reportContextFailure(ctx, flags.json);

  const result = renderProject(ctx, {
    frames: flags.frames,
    rebuild: flags.noBuild !== true,
    outDir: flags.out,
  });
  const value = renderResult(result);

  if (flags.json) {
    writeJson(value);
    if (!result.ok) reportRenderFailure(result);
  } else if (result.ok) {
    console.log(`[lvglui] png=${result.pngPath} meta=${result.metaPath} tree=${result.treePath}`);
  } else {
    reportRenderFailure(result);
  }

  return result.ok ? 0 : exitForRender(result);
}

async function runBuild(flags) {
  const ctx = loadFor('build', flags);
  if (!ctx.ok) return reportContextFailure(ctx, flags.json);

  const found = findToolchainFor(ctx);
  if (!found.ok) {
    const problems = found.problems ?? ['toolchain not found'];
    for (const problem of problems) console.error(`[lvglui] ${problem}`);
    if (flags.json) writeJson({ ok: false, stage: 'toolchain', problems });
    return 2;
  }

  const buildCtx = { ...ctx, toolchain: toolchainPaths(found) };
  try {
    writeBuildScript(buildCtx);
  } catch (e) {
    console.error(`[lvglui] cannot write build script: ${e.message}`);
    if (flags.json) writeJson({ ok: false, stage: 'ctx', problems: [e.message] });
    return 2;
  }

  const build = buildHost(buildCtx);
  let diagnostics = null;
  if (!build.ok) {
    let log = build.stderr;
    try {
      if (build.logPath) log = fs.readFileSync(build.logPath, 'utf8');
    } catch {
      // keep captured stderr
    }
    diagnostics = parseDiagnostics(log ?? '', { root: ctx.root, toolDir: ctx.toolDir });
  }

  const value = {
    ok: build.ok,
    exitCode: build.exitCode,
    durationMs: build.durationMs,
    logPath: build.logPath,
    ...(diagnostics ? { diagnostics } : {}),
  };

  if (flags.json) {
    writeJson(value);
    if (!build.ok) printDiagnostics(diagnostics);
  } else if (build.ok) {
    console.log(`[lvglui] build ok exit=0 log=${build.logPath} (${build.durationMs} ms)`);
  } else {
    console.error(`[lvglui] build failed exit=${build.exitCode ?? '?'} log=${build.logPath ?? '(none)'}`);
    printDiagnostics(diagnostics);
  }

  return build.ok ? 0 : 1;
}

async function runDoctor(flags) {
  const ctx = loadFor('doctor', flags);
  const toolchain = findToolchainFor(ctx);
  const result = doctor(ctx, { toolchain });

  if (flags.json) {
    writeJson(result);
    for (const check of result.problems ?? []) {
      if (typeof check === 'string') {
        console.error(`[lvglui] ${check}`);
        continue;
      }
      console.error(`[lvglui] [${check.status ?? 'fail'}] ${check.id ?? '?'}: ${check.message ?? ''}`);
      const detail = check.detail === undefined ? [] : (Array.isArray(check.detail) ? check.detail : [check.detail]);
      for (const line of detail) console.error(`       ${line}`);
    }
  } else {
    for (const warning of ctx.warnings ?? []) console.error(`[lvglui] warning: ${warning}`);
    printChecks(result.checks);
    if (!result.ok) console.error('[lvglui] doctor 发现问题，见上面的 fail 项');
  }

  return result.ok ? 0 : 1;
}

async function runInit(flags) {
  const ctx = loadFor('init', flags);
  const result = initProject(ctx, {
    width: flags.width,
    height: flags.height,
    force: flags.force === true,
  });

  if (!result.ok) {
    for (const problem of result.problems) console.error(`[lvglui] ${problem}`);
    return 2;
  }

  console.log(`[lvglui] init 创建了 ${result.created.length} 个文件（${ctx.root}）：`);
  for (const created of result.created) console.log(`  + ${created}`);
  console.log('');
  console.log(result.snippet);
  console.error('[lvglui] 把上面的代码放到 LVGL 显示/触摸初始化完成之后');

  if (flags.noRender) return 0;

  // init 刚写完 lvglui.json / UI 源码；必须用 requireUi:true 重新探测，
  // 旧 ctx 里没有新 UI。
  const next = loadContext({
    startDir: process.cwd(),
    projectDir: flags.project,
    cliWidth: flags.width,
    cliHeight: flags.height,
    requireUi: true,
  });
  if (!next.ok) {
    for (const problem of next.problems) console.error(`[lvglui] ${problem}`);
    return 2;
  }

  const toolchain = findToolchainFor(next);
  const check = doctor(next, { toolchain });
  printChecks(check.checks);

  const rendered = renderProject(next, { frames: flags.frames, outDir: flags.out });
  if (rendered.ok) {
    console.log(`[lvglui] png=${rendered.pngPath} meta=${rendered.metaPath} tree=${rendered.treePath}`);
    return 0;
  }

  reportRenderFailure(rendered);
  return exitForRender(rendered);
}

async function runPreview(flags) {
  const ctx = loadFor('preview', flags);
  if (!ctx.ok) return reportContextFailure(ctx, false);

  const result = previewProject(ctx);
  if (!result.ok) {
    console.error(`[lvglui] preview failed (${result.error?.stage ?? 'unknown'}): ${result.error?.message ?? 'unknown error'}`);
    switch (result.error?.stage) {
      case 'ctx':
      case 'toolchain':
        return 2;
      case 'build':
        return 1;
      default:
        return 3;
    }
  }

  console.log(`[lvglui] preview pid=${result.pid} args=${(result.args ?? []).join(' ')}`);
  // previewProject 的窗口是 detached:false 的子进程；不主动退出的话 CLI 会一直
  // 挂在这个 child handle 上。先 flush stdout，再退出，窗口本身继续运行。
  process.stdout.write('', () => process.exit(0));
  return 0;
}

function runWatch(flags) {
  const ctx = loadFor('watch', flags);
  if (!ctx.ok) return reportContextFailure(ctx, false);

  console.error(`[lvglui] watching ${ctx.uiDir}`);
  writeJson({
    event: 'watching',
    project: ctx.root,
    uiDir: ctx.uiDir,
    width: ctx.display?.width ?? null,
    height: ctx.display?.height ?? null,
  });

  let busy = false;
  let queued = false;
  let timer = null;

  const renderNow = () => {
    timer = null;
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    const result = renderProject(ctx, {
      frames: flags.frames,
      rebuild: true,
      outDir: flags.out,
    });
    writeJson(renderResult(result));
    if (!result.ok) reportRenderFailure(result);
    busy = false;
    if (queued) {
      queued = false;
      renderNow();
    }
  };

  let watcher;
  try {
    watcher = fs.watch(ctx.uiDir, { recursive: true }, (_event, filename) => {
      if (filename && !/\.(c|h)$/i.test(String(filename))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(renderNow, 300);
    });
  } catch (e) {
    console.error(`[lvglui] cannot watch ${ctx.uiDir}: ${e.message}`);
    return 3;
  }

  renderNow();
  const stop = () => {
    try {
      watcher.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>lvglui preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #12151c; color: #e6e9f0;
    font: 13px/1.4 ui-monospace, Consolas, monospace; }
  main { display: flex; flex-direction: column; align-items: center; gap: 12px;
    padding: 16px; box-sizing: border-box; min-height: 100%; }
  img { max-width: 100%; height: auto; image-rendering: pixelated;
    box-shadow: 0 0 0 1px #2a2f3a; background: #000; }
  pre { margin: 0; color: #9aa4b2; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <img id="shot" src="/shot.png" alt="LVGL 渲染结果">
  <pre id="status">waiting for first render…</pre>
</main>
<script>
const img = document.getElementById('shot');
const status = document.getElementById('status');
const events = new EventSource('/events');
events.onmessage = (event) => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.ok && data.bust) {
    img.src = '/shot.png?t=' + data.bust;
    const t = data.timings || {};
    status.textContent = 'ok  ' + new Date(data.t).toLocaleTimeString()
      + '  frames=' + (data.frames ?? '?')
      + '  shot=' + (t.shotMs ?? '?') + 'ms  encode=' + (t.encodeMs ?? '?') + 'ms';
  } else {
    status.textContent = 'render failed: ' + (data.error && data.error.message || 'unknown error');
  }
};
events.onerror = () => { status.textContent = 'event stream disconnected; retrying…'; };
</script>
</body>
</html>`;

async function runServe(flags) {
  const ctx = loadFor('serve', flags);
  if (!ctx.ok) return reportContextFailure(ctx, false);

  const clients = new Set();
  const shotDir = flags.out !== undefined ? path.resolve(flags.out) : ctx.outDir;
  let last = null;
  let busy = false;
  let queued = false;

  const broadcast = (result) => {
    const payload = {
      t: Date.now(),
      ok: result.ok === true,
      bust: Date.now(),
      frames: result.meta?.frames ?? null,
      timings: result.meta
        ? {
            buildMs: result.meta.buildMs,
            shotMs: result.meta.shotMs,
            encodeMs: result.meta.encodeMs,
          }
        : null,
      error: result.error ?? null,
      diagnostics: result.diagnostics
        ? {
            summary: result.diagnostics.summary,
            errors: result.diagnostics.errors.slice(0, 5),
            hints: result.diagnostics.hints,
          }
        : null,
    };
    last = payload;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(data);
      } catch {
        clients.delete(client);
      }
    }
  };

  // Never call renderProject() from an HTTP callback: it uses spawnSync and
  // would freeze the event loop. One child CLI render at a time instead.
  const queueRender = () => {
    if (busy) {
      queued = true;
      return;
    }
    busy = true;

    const args = [fileURLToPath(import.meta.url), 'render', '--project', ctx.root, '--json'];
    if (flags.width !== undefined) args.push('--width', String(flags.width));
    if (flags.height !== undefined) args.push('--height', String(flags.height));
    if (flags.frames !== undefined) args.push('--frames', String(flags.frames));
    if (flags.out !== undefined) args.push('--out', flags.out);
    if (flags.noBuild === true) args.push('--no-build');

    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, args, {
      // Keep the child's cwd equal to this process so a relative --out
      // resolves to the same directory that /shot.png serves.
      cwd: process.cwd(),
      windowsHide: true,
      env: process.env,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      broadcast(result);
      busy = false;
      if (queued) {
        queued = false;
        queueRender();
      }
    };

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (e) => {
      finish({ ok: false, error: { stage: 'spawn', message: e.message } });
    });
    child.on('close', (code) => {
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        result = {
          ok: false,
          error: {
            stage: 'json',
            message: `render child exited ${code} without JSON${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`,
          },
        };
      }
      finish(result);
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : PAGE);
      return;
    }

    if (url.pathname === '/shot.png') {
      let stream;
      try {
        stream = fs.createReadStream(path.join(shotDir, 'shot.png'));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`cannot read shot.png: ${e.message}`);
        return;
      }
      stream.once('error', () => {
        if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('shot.png not ready');
      });
      stream.once('open', () => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        if (req.method === 'HEAD') {
          stream.destroy();
          res.end();
          return;
        }
        stream.pipe(res);
      });
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      if (last) res.write(`data: ${JSON.stringify(last)}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(last ?? { ok: null, pending: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const basePort = flags.port ?? 8765;

  const listen = (port, remaining) => {
    const onError = (e) => {
      server.removeListener('listening', onListening);
      if (e.code === 'EADDRINUSE' && remaining > 0) {
        console.error(`[lvglui] port ${port} busy, trying ${port + 1}`);
        listen(port + 1, remaining - 1);
        return;
      }
      console.error(`[lvglui] cannot listen on 127.0.0.1:${port}: ${e.message}`);
      process.exitCode = 3;
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      console.error(`[lvglui] serve http://127.0.0.1:${actual}`);
      console.error(`[lvglui] project=${ctx.root} out=${shotDir}`);
      queueRender();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  };

  listen(basePort, 9);

  const stop = () => {
    try {
      server.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

async function runDshInstall(flags) {
  const modulePath = path.join(TOOL_DIR, 'core', 'dsh.mjs');
  if (!fs.existsSync(modulePath)) {
    console.error('[lvglui] dsh installer not available: core/dsh.mjs 不存在');
    if (flags.json) writeJson({ ok: false, problems: ['core/dsh.mjs not available'] });
    return 2;
  }

  const { installDsh } = await import('../core/dsh.mjs');
  const result = installDsh(TOOL_DIR);
  const target = `file:${toPosix(path.join(TOOL_DIR, 'dsh'))}`;

  if (!result?.ok) {
    const problems = result?.problems ?? ['dsh install failed'];
    for (const problem of problems) console.error(`[lvglui] ${problem}`);
    if (flags.json) writeJson({ ok: false, problems, target });
    return 2;
  }

  if (flags.json) {
    writeJson({
      ok: true,
      patchFile: result.patchFile ?? null,
      target,
      note: '移动工具目录后需要重新运行 dsh install',
    });
    return 0;
  }

  console.log(`[lvglui] dsh 插件已生成: ${result.patchFile ?? path.join(TOOL_DIR, 'dsh')}`);
  console.log(`[lvglui] 安装: plugin_manager install_bundle target="${target}"`);
  console.log('[lvglui] 注意: 移动工具目录后需要重新运行 dsh install');
  return 0;
}

async function runFont(command, flags, positionals) {
  const ctx = loadFor('font', flags);
  if (!ctx.ok) return reportContextFailure(ctx, flags.json);

  let result;
  if (command === 'font add') {
    result = fontAdd(ctx, {
      fontPath: flags.font ?? positionals[0],
      preset: flags.preset,
      size: flags.size,
      chars: flags.chars,
      name: flags.name,
      dynamic: flags.dynamic,
    });
  } else if (command === 'font off') {
    result = fontOff(ctx);
  } else {
    result = fontStatus(ctx);
  }

  if (flags.json) {
    writeJson(result);
    return result.ok ? 0 : 2;
  }

  if (!result.ok) {
    for (const problem of result.problems ?? ['font operation failed']) {
      console.error(`[lvglui] ${problem}`);
    }
    return 2;
  }

  if (command === 'font add') {
    console.log(`[lvglui] font ${result.mode}/${result.dynamic ?? 'labels'}: ${result.file} (${result.chars} chars, ${result.glyphs} glyphs)`);
    if ((result.missing ?? []).length > 0) {
      console.log(`[lvglui] 缺字: ${result.missing.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(', ')}`);
    }
  } else if (command === 'font off') {
    console.log(`[lvglui] font off; 移除 ${result.removed.length} 个文件`);
    for (const file of result.removed) console.log(`  - ${file}`);
  } else {
    console.log(`[lvglui] font mode=${result.mode} dynamic=${result.dynamic ?? 'labels'} chars=${result.chars} glyphs=${result.glyphs} file=${result.file || '(none)'}`);
  }
  for (const warning of result.warnings ?? []) console.error(`[lvglui] warning: ${warning}`);
  return 0;
}

/**
 * Run one CLI command. Async because `dsh install` and watch/serve setup use
 * promises; the long-running commands return immediately and keep the event
 * loop alive via their watcher/server handles.
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code (also assigned to process.exitCode)
 */
export async function main(argv = process.argv.slice(2)) {
  const { command, flags, positionals } = parseArgs(argv);

  if (command === 'help') {
    console.log(USAGE);
    process.exitCode = 0;
    return 0;
  }

  const problem = validationProblem(command, flags, positionals);
  if (problem) {
    console.error(`[lvglui] ${problem}`);
    console.error(USAGE);
    process.exitCode = 2;
    return 2;
  }

  let code;
  try {
    switch (command) {
      case 'render':
        code = await runRender(flags);
        break;
      case 'build':
        code = await runBuild(flags);
        break;
      case 'doctor':
        code = await runDoctor(flags);
        break;
      case 'init':
        code = await runInit(flags);
        break;
      case 'preview':
        code = await runPreview(flags);
        break;
      case 'watch':
        code = runWatch(flags);
        break;
      case 'serve':
        code = await runServe(flags);
        break;
      case 'dsh install':
        code = await runDshInstall(flags);
        break;
      case 'font add':
      case 'font off':
      case 'font status':
        code = await runFont(command, flags, positionals);
        break;
      default:
        code = 2;
    }
  } catch (e) {
    console.error(`[lvglui] unexpected error: ${e.stack ?? e.message}`);
    code = 3;
  }

  process.exitCode = code;
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
