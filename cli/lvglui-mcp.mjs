#!/usr/bin/env node
// lvglui-mcp: MCP (stdio, newline-delimited JSON-RPC 2.0) server exposing the
// headless LVGL renderer so an agent can "look at" the screen it just wrote.
//
// Tools: render_ui (returns a PNG image content block), build_ui, preview_ui, doctor.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { build, context, doctor, preview, render } from './core.mjs';

const PROTOCOL = '2024-11-05';

const PROJECT_ARG = {
  type: 'string',
  description: 'ESP-IDF 工程目录（默认当前工作目录，会自动往上找带 project() 的 CMakeLists.txt）',
};

const TOOLS = [
  {
    name: 'render_ui',
    description:
      '把工程的界面（components/app_ui/*.c）用主机上的 LVGL 无头渲染成 PNG 并返回图片，' +
      '分辨率/颜色格式/字体配置都跟着固件的 sdkconfig 走。看布局、看配色、看文字有没有溢出。' +
      '改完 .c 再调一次，看图再改，直到满意。同一份源码永远渲染出同样的像素。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        out: { type: 'string', description: '输出 PNG 路径（默认 tools/ui-preview/out/preview.png）' },
        frames: { type: 'number', description: '截图前先跑几帧（默认 12 × 33ms）' },
        rebuild: { type: 'boolean', description: '渲染前先编译（默认 true）' },
      },
    },
  },
  {
    name: 'build_ui',
    description: '只编译不渲染（ui.dll / preview.exe / shot.exe），有编译错误就返回错误。',
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG } },
  },
  {
    name: 'preview_ui',
    description: '在桌面上打开实时预览窗口，保存界面源码就会自动重载。',
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG } },
  },
  {
    name: 'doctor',
    description: '自检：编译器在不在、LVGL 源码在哪、界面目录和入口函数探测到了什么。',
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG } },
  },
];

function text(t) {
  return { type: 'text', text: t };
}

function callTool(name, args = {}) {
  const ctx = context(args.project);
  if (!ctx.ok) {
    return {
      isError: true,
      content: [text(`探测工程失败（${ctx.root}）：\n${ctx.problems.join('\n')}\n\n` +
        '如果这是一个还没有界面的新工程，先跑 `lvglui init`。')],
    };
  }

  if (name === 'render_ui') {
    const r = render(ctx, { out: args.out, frames: args.frames || 12, rebuild: args.rebuild !== false });
    if (!r.ok) {
      return {
        isError: true,
        content: [text(`render 在 "${r.stage}" 阶段失败:\n${JSON.stringify(r.errors, null, 2)}`)],
      };
    }
    const meta = {
      png: r.png,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      entry: r.entry,
      uiDir: r.uiDir,
      config: r.config,
      names: r.names,
      ms: r.timings,
    };
    return {
      content: [
        { type: 'image', data: readFileSync(r.png).toString('base64'), mimeType: 'image/png' },
        text(JSON.stringify(meta)),
      ],
    };
  }

  if (name === 'build_ui') {
    const b = build(ctx, { quiet: true });
    return {
      isError: !b.ok,
      content: [text(JSON.stringify({ ok: b.ok, ms: b.ms, config: b.config, errors: b.errors }, null, 2))],
    };
  }

  if (name === 'preview_ui') {
    const p = preview(ctx);
    return { isError: !p.ok, content: [text(JSON.stringify(p))] };
  }

  if (name === 'doctor') {
    const d = doctor(ctx);
    return { isError: !d.ok, content: [text(JSON.stringify(d, null, 2))] };
  }

  return { isError: true, content: [text(`unknown tool: ${name}`)] };
}

function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'lvglui', version: '0.1.0' },
        instructions:
          '界面是 C，写在工程的 components/app_ui/ 里（只能 include lvgl.h）。' +
          '画布尺寸、颜色格式、字体都跟着工程的 sdkconfig 走。' +
          '布局常量放文件顶部 #define；每个业务要用的控件用 lv_obj_set_name() 起名（这是契约）。' +
          '改完调 render_ui 看图，不对再改。',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const out = callTool(name, args);
        return reply({ content: out.content, isError: !!out.isError });
      } catch (e) {
        return reply({ content: [text(`internal error: ${e.message}`)], isError: true });
      }
    }
    default:
      return id === undefined ? null : error(-32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
    return;
  }
  try {
    const out = handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } }) + '\n');
    }
  }
});

rl.on('close', () => process.exit(0));
