#!/usr/bin/env node
// lvglui —— 用 C 写的 LVGL 界面，在 PC 上无头渲染成图 / 实时预览。
//
//   node cli/lvglui.mjs render  [--project <dir>] [--out <png>] [--frames 12] [--no-build] [--quiet]
//   node cli/lvglui.mjs build   [--project <dir>]
//   node cli/lvglui.mjs watch   [--project <dir>] [--out <png>]
//   node cli/lvglui.mjs serve   [--project <dir>] [--port 8765]
//   node cli/lvglui.mjs preview [--project <dir>]
//   node cli/lvglui.mjs init    [--project <dir>]
//   node cli/lvglui.mjs doctor  [--project <dir>]
//
// --project 默认是当前目录（会自动往上找带 project() 的 CMakeLists.txt）。
// render 把结果以 JSON 打到 stdout：{ ok, png, width, height, bytes, entry, names, timings }
// watch  每行一个 JSON（每重渲一次一行），给 VS Code 面板之类的宿主读。
import { existsSync, mkdirSync, readFileSync, watch as fsWatch, writeFileSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { build, context, doctor, preview, render, TOOL_DIR } from './core.mjs';

const VALUE_FLAGS = new Set(['project', 'out', 'frames', 'entry', 'port', 'width', 'height']);

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

function fail(obj) {
  console.error(JSON.stringify(obj, null, 2));
  process.exit(1);
}

function ctxOrFail(flags) {
  const ctx = context(flags.project);
  if (!ctx.ok) fail({ ok: false, stage: 'detect', problems: ctx.problems, root: ctx.root });
  if (flags.entry) { ctx.entry = String(flags.entry); ctx.entryHow = 'cli'; }
  return ctx;
}

const HOME_C = `/**
 * 界面入口。工具 / 模型只改 components/app_ui 里的文件。
 *
 * 规则（很重要）：
 *   1. 只依赖 lvgl.h —— 不要 include driver/*.h、esp_*.h，否则 PC 上编不过
 *   2. 每个业务要用的控件，都用 lv_obj_set_name() 起个名字，名字就是契约
 *   3. 参数（颜色/尺寸/位置）尽量放在文件顶部的宏里，改起来一眼能看到
 */
#include "lvgl.h"
#include "home.h"

#define COLOR_BG      0x12151C
#define COLOR_TEXT    0xE6E9F0
#define COLOR_ACCENT  0x9429FF

lv_obj_t * home_create(lv_obj_t * parent)
{
    lv_obj_t * root = lv_obj_create(parent);
    lv_obj_set_size(root, lv_pct(100), lv_pct(100));
    lv_obj_set_style_bg_color(root, lv_color_hex(COLOR_BG), 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_set_scroll_dir(root, LV_DIR_NONE);

    lv_obj_t * title = lv_label_create(root);
    lv_obj_set_name(title, "title");
    lv_label_set_text(title, "Hello");
    lv_obj_set_style_text_color(title, lv_color_hex(COLOR_TEXT), 0);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 16);

    return root;
}
`;

const HOME_H = `#ifndef HOME_H
#define HOME_H

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/** parent 传 NULL 时创建一个新屏幕 */
lv_obj_t * home_create(lv_obj_t * parent);

#ifdef __cplusplus
}
#endif

#endif /* HOME_H */
`;

const APP_UI_CMAKELISTS = `# 界面组件：只依赖 lvgl，不依赖任何驱动/业务代码
idf_component_register(
    SRC_DIRS "."
    INCLUDE_DIRS "."
    REQUIRES lvgl__lvgl
)
`;

function init(flags) {
  const ctx = context(flags.project);
  const root = ctx.root;
  const uiRel = 'components/app_ui';
  const uiDir = path.join(root, uiRel);
  const created = [];
  mkdirSync(uiDir, { recursive: true });
  for (const [name, text] of [
    ['home.c', HOME_C],
    ['home.h', HOME_H],
    ['CMakeLists.txt', APP_UI_CMAKELISTS],
  ]) {
    const dest = path.join(uiDir, name);
    if (!existsSync(dest)) { writeFileSync(dest, text, 'utf8'); created.push(dest); }
  }
  const confFile = path.join(root, 'lvglui.json');
  if (!existsSync(confFile)) {
    writeFileSync(confFile, `${JSON.stringify({ uiDir: uiRel, entry: 'home_create' }, null, 2)}\n`, 'utf8');
    created.push(confFile);
  }

  const next = context(flags.project);
  const result = {
    ok: next.ok,
    root,
    uiDir: next.uiDir,
    entry: next.entry,
    created,
    problems: next.problems,
  };
  if (next.ok) result.render = render(next, { out: path.join(TOOL_DIR, 'out', 'home.png') });
  return result;
}

/**
 * 盯着界面目录：谁改了（手改、DSH 里的模型改、git checkout）都重渲一次。
 * onRender(json, ctx, outPath) 每渲一次调一次。
 */
function makeWatcher(flags, onRender) {
  const ctx = ctxOrFail(flags);
  const out = path.resolve(flags.out || path.join(TOOL_DIR, 'out', 'preview.png'));
  let timer = null;
  let busy = false;
  let queued = false;
  let closed = false;

  const run = () => {
    if (closed) return;
    if (busy) { queued = true; return; }
    busy = true;
    let r;
    try {
      r = render(ctx, { out, frames: flags.frames ? Number(flags.frames) : 12 });
    } catch (e) {
      r = { ok: false, stage: 'internal', png: null, errors: [{ msg: e.message }] };
    }
    busy = false;
    if (closed) return;
    onRender({ t: new Date().toISOString(), ...r }, ctx, out);
    if (queued) { queued = false; schedule(); }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  };

  const watcher = fsWatch(ctx.uiDir, { recursive: true }, (evt, file) => {
    if (!file || !/\.(c|h)$/i.test(file)) return;
    schedule();
  });

  run();  // 先渲一次，打开页面/面板立刻有图
  return {
    ctx,
    out,
    schedule,
    info: {
      event: 'watching',
      uiDir: ctx.uiDir,
      entry: ctx.entry,
      project: ctx.root,
      config: ctx.sdkconfig ? 'sdkconfig' : 'default',
    },
    stop() {
      closed = true;
      clearTimeout(timer);
      try { watcher.close(); } catch { /* ignore */ }
    },
  };
}

/** watch：每渲一次往 stdout 打一行 JSON，给宿主（VS Code 面板等）读 */
function watchLoop(flags) {
  const w = makeWatcher(flags, (json) => console.log(JSON.stringify(json)));
  console.log(JSON.stringify(w.info));
  const stop = () => { w.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>lvglui 预览</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f1116; color:#c9d1d9; font:13px/1.5 ui-monospace,Consolas,monospace;
         display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; }
  #wrap { padding:16px; }
  img { display:block; width:240px; height:320px; image-rendering:pixelated;
        border-radius:6px; box-shadow:0 0 0 1px #2a2f3a, 0 8px 30px #0008; }
  #st { margin-top:12px; text-align:center; min-height:2.4em; color:#7d8590; }
  #st b { color:#3fb950; } #st .err { color:#f85149; }
  #st a.err { text-decoration:underline; cursor:pointer; }
  #st br + span { font-size:12px; }
</style>
<div id="wrap">
  <img id="shot" alt="还没渲出来">
  <div id="st">渲染中…</div>
</div>
<script>
  const img = document.getElementById('shot');
  const st = document.getElementById('st');
  let n = 0;
  function bust() { img.src = '/shot.png?t=' + Date.now() + '&n=' + (++n); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function jump(msg) {
    const m = String(msg).match(/^(.*?)\\((\\d+)(?:,(\\d+))?\\):\\s*(.*)$/);
    if (!m) return null;
    const f = m[1].replace(/\\\\/g, '/');
    const line = m[2];
    const col = m[3] || '1';
    return {
      url: 'vscode://file/' + encodeURI(f) + ':' + line + ':' + col,
      label: f.split('/').pop() + ':' + line + ':' + col,
      rest: m[4],
    };
  }
  function status(d) {
    if (!d || d.t === undefined) { st.textContent = '渲染中…'; return; }
    const t = (d.t || '').slice(11, 19);
    if (d.ok) {
      st.innerHTML = '<b>OK</b> ' + t + ' · ' + (d.bytes || 0) + ' B · 编译 ' +
        ((d.timings || {}).build || 0) + ' ms';
      return;
    }
    const list = (d.errors || []).slice(0, 3);
    if (!list.length) { st.innerHTML = '<span class="err">渲染失败</span>'; return; }
    st.innerHTML = list.map(function (e) {
      const j = jump(e.msg);
      if (!j) return '<span class="err">' + esc(e.msg) + '</span>';
      return '<a class="err" href="' + j.url + '">' + esc(j.label) + '</a>' +
             '<br><span class="err">' + esc(j.rest) + '</span>';
    }).join('<br>');
  }
  const es = new EventSource('/events');
  es.onmessage = (e) => { let d = {}; try { d = JSON.parse(e.data); } catch {} bust(); status(d); };
  es.onerror = () => { st.textContent = '连接断了，重连中…'; };
  bust();
</script>
</html>`;

/**
 * 用 Chrome/Edge 的 app 模式开一个没地址栏的小窗 —— 钉在屏幕边上，不用切窗口。
 * 找不到浏览器就退回默认浏览器开标签页。
 */
function openPreviewWindow(url, width, height) {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const exe = cands.find((p) => existsSync(p));
  if (exe) {
    spawn(exe, [
      '--app=' + url,
      '--window-size=' + width + ',' + height,
      '--window-position=60,60',
    ], { detached: true, stdio: 'ignore' }).unref();
    return exe;
  }
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return null;
}

/** serve：本地网页，保存即刷新。可以钉在第二块屏，也可以塞进 VS Code 的 Simple Browser */
function serveLoop(flags) {
  const clients = new Set();
  let last = null;

  const w = makeWatcher(flags, (json) => {
    last = json;
    if (!json.ok) console.log('[lvglui] 渲染失败：' + ((json.errors && json.errors[0] && json.errors[0].msg) || '?'));
    const data = 'data: ' + JSON.stringify({
      t: json.t, ok: json.ok, bytes: json.bytes || 0, timings: json.timings || null,
      errors: json.errors || [],
    }) + '\n\n';
    for (const res of clients) { try { res.write(data); } catch { /* ignore */ } }
  });

  console.log('[lvglui] 界面: ' + w.ctx.uiDir);
  console.log('[lvglui] 入口: ' + w.ctx.entry + '  配置来源: ' + (w.ctx.sdkconfig ? 'sdkconfig' : '内置默认'));

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (url === '/shot.png') {
      try {
        const buf = readFileSync(w.out);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('还没渲染出来');
      }
      return;
    }
    if (url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(last || {}));
      return;
    }
    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const base = Number(flags.port) || 8765;
  let port = base;
  const listen = () => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && port - base < 10) {
        port += 1;
        listen();
        return;
      }
      console.error('[lvglui] 起不了服务：' + e.message);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + port;
      console.log('[lvglui] 预览: ' + url + '   (Ctrl+C 退出)');
      if (flags.open) {
        const w = Number(flags.width) || 300;
        const h = Number(flags.height) || 460;
        const exe = openPreviewWindow(url, w, h);
        console.log('[lvglui] 已开小窗 ' + w + 'x' + h + (exe ? ' · ' + exe.split('\\').pop() : ' · 默认浏览器'));
      }
    });
  };
  listen();

  const stop = () => {
    w.stop();
    for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const { flags, rest } = parseArgs(process.argv.slice(2));
const cmd = rest[0] || 'render';

switch (cmd) {
  case 'render': {
    const ctx = ctxOrFail(flags);
    const r = render(ctx, {
      out: flags.out,
      frames: flags.frames ? Number(flags.frames) : 12,
      rebuild: !flags.noBuild,
    });
    if (!r.ok) fail(r);
    if (flags.quiet) console.log(r.png);
    else console.log(JSON.stringify(r, null, flags.json ? 2 : 0));
    break;
  }
  case 'build': {
    const ctx = ctxOrFail(flags);
    const b = build(ctx, { quiet: false });
    if (!b.ok) fail({ ok: false, ms: b.ms, errors: b.errors });
    console.log(JSON.stringify({ ok: true, ms: b.ms, config: b.config, buildDir: ctx.buildDir }));
    break;
  }
  case 'watch': {
    watchLoop(flags);
    break;
  }
  case 'serve': {
    serveLoop(flags);
    break;
  }
  case 'preview': {
    const ctx = ctxOrFail(flags);
    const p = preview(ctx);
    if (!p.ok) fail(p);
    console.log(JSON.stringify(p));
    break;
  }
  case 'init': {
    const r = init(flags);
    if (!r.ok) fail(r);
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case 'doctor': {
    const ctx = context(flags.project);
    const d = doctor(ctx);
    console.log(JSON.stringify(d, null, 2));
    process.exit(d.ok ? 0 : 1);
    break;
  }
  default: {
    console.error(`未知命令: ${cmd}`);
    console.error('  render | build | preview | init | doctor   加 --project <dir> 指定工程');
    process.exit(2);
  }
}