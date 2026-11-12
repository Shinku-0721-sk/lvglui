#!/usr/bin/env node
// lvglui-mcp: MCP (stdio, newline-delimited JSON-RPC 2.0) server exposing the
// headless LVGL renderer so an agent can "look at" the screen it just wrote.
//
// The server is intentionally thin: every command maps to one core seam from
// core/context.mjs, core/render.mjs, core/build.mjs, core/doctor.mjs or
// core/preview.mjs. It writes only JSON-RPC to stdout; diagnostics live in the
// tool result or in the build log on disk.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { buildHost, writeBuildScript } from '../core/build.mjs';
import { loadContext } from '../core/context.mjs';
import { doctor as runDoctor } from '../core/doctor.mjs';
import { initProject } from '../core/init.mjs';
import { previewProject } from '../core/preview.mjs';
import { renderProject } from '../core/render.mjs';
import { findToolchain } from '../core/toolchain.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: 'lvglui', version: '1.0.0-rc.1' };

const PROJECT_ARG = {
  type: 'string',
  description: 'ESP-IDF 工程目录（默认 LVGLUI_PROJECT 或当前工作目录）',
};

const WIDTH_ARG = { type: 'number', description: '屏幕宽；缺省用 lvglui.json/sdkconfig' };
const HEIGHT_ARG = { type: 'number', description: '屏幕高；缺省用 lvglui.json/sdkconfig' };

const TOOLS = [
  {
    name: 'detect_project',
    description:
      '探测 ESP-IDF 工程：找工程根、UI 目录、入口函数、IDF/LVGL、分辨率和色深。' +
      '只读；不会写文件。用于在写界面前确认工具看到了正确的工程。',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG, width: WIDTH_ARG, height: HEIGHT_ARG },
      additionalProperties: false,
    },
  },
  {
    name: 'init_ui',
    description:
      '在已有 ESP-IDF 工程里注入 UI 组件骨架（components/app_ui 与 lvglui.json），' +
      '不改任何现有文件，并返回需要粘到 main 的接入片段。已有 lvglui.json 时拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        width: WIDTH_ARG,
        height: HEIGHT_ARG,
        force: { type: 'boolean', description: 'v1 保留参数，当前不覆盖已有文件' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'render_ui',
    description:
      '编译并渲染界面为 PNG 图片，同时返回控件树和元数据。改完 .c 再调一次，' +
      '看图再改。同一份源码、同一配置下像素确定。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        width: WIDTH_ARG,
        height: HEIGHT_ARG,
        frames: { type: 'number', description: '截图前跑几帧（默认 12 × 33ms）' },
        rebuild: { type: 'boolean', description: '渲染前先编译（默认 true）' },
        outDir: { type: 'string', description: '输出目录（默认工程的 .lvglui/out）' },
        page: {
          type: 'string',
          description: '只渲染某一页（界面需实现 ui_page_count/ui_page_name/ui_page_show）',
        },
        allPages: {
          type: 'boolean',
          description: '渲染所有页，返回 contact sheet 总览图；每页单独的 PNG 也在 meta.pages 里',
        },
        scroll: {
          type: 'string',
          description: '先滚动再截图：<y>、<name>=<y>、<name>=bottom（不能与 allPages 同用）',
        },
        maxHeapPct: {
          type: 'number',
          description: 'LVGL 堆使用率上限（1-100）；超过时返回 budget.exceeded=true，应先优化界面',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_ui',
    description: '只编译不渲染（ui.dll / preview.exe / shot.exe），返回退出码和 build.log 路径。',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG, width: WIDTH_ARG, height: HEIGHT_ARG },
      additionalProperties: false,
    },
  },
  {
    name: 'doctor',
    description: '自检：IDF/LVGL、分辨率、UI 目录/入口、SRCS、平台头文件、工具链和字体。',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG, width: WIDTH_ARG, height: HEIGHT_ARG },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_ui',
    description: '在桌面上打开实时预览窗口；保存界面源码会自动重建并重载。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        width: WIDTH_ARG,
        height: HEIGHT_ARG,
        topmost: { type: 'boolean', description: '让窗口保持在其它窗口之上（Ctrl+Alt+T 也可以随时切换）' },
      },
      additionalProperties: false,
    },
  },
];

function text(t) {
  return { type: 'text', text: String(t) };
}

function jsonText(value) {
  return text(JSON.stringify(value));
}

function toolResult(value, isError = false) {
  return { content: [jsonText(value)], isError };
}

function errorResult(message, extra = {}) {
  return toolResult({ ok: false, message, ...extra }, true);
}

function projectArg(args) {
  const raw = args?.project ?? process.env.LVGLUI_PROJECT ?? process.cwd();
  return path.resolve(raw);
}

function load(project, requireUi, args = {}) {
  return loadContext({
    projectDir: project,
    cliWidth: args.width,
    cliHeight: args.height,
    requireUi,
  });
}

function pickContext(ctx) {
  return {
    ok: ctx.ok,
    root: ctx.root,
    uiDir: ctx.uiDir,
    entry: ctx.entry,
    entryHow: ctx.entryHow,
    idf: ctx.idf,
    lvgl: ctx.lvgl,
    display: ctx.display,
    problems: ctx.problems,
    warnings: ctx.warnings,
  };
}

function resolveToolchain(ctx) {
  const found = findToolchain({ root: ctx.root, config: ctx.config, idf: ctx.idf, env: process.env });
  if (!found.ok) return { ok: false, problems: found.problems };
  return {
    ok: true,
    toolchain: { vcvars: found.vcvars, cmake: found.cmake, ninja: found.ninja },
    source: found.source,
  };
}

async function callTool(name, args = {}) {
  const project = projectArg(args);

  if (name === 'detect_project') {
    const ctx = load(project, false, args);
    // Discovery is informational: a missing display pair is a finding, not a
    // transport-level tool error.
    return toolResult(pickContext(ctx), false);
  }

  if (name === 'init_ui') {
    const ctx = loadContext({
      projectDir: project,
      cliWidth: args.width,
      cliHeight: args.height,
      requireUi: false,
    });
    if (!ctx.ok) return errorResult('工程探测失败，未写入任何文件', { problems: ctx.problems });
    const r = initProject(ctx, { width: args.width, height: args.height, force: args.force === true });
    return toolResult(r, !r.ok);
  }

  if (name === 'render_ui') {
    const ctx = load(project, true, args);
    if (!ctx.ok) return errorResult('工程探测失败', { problems: ctx.problems });
    const r = renderProject(ctx, {
      frames: args.frames,
      rebuild: args.rebuild !== false,
      outDir: args.outDir,
      page: args.page,
      allPages: args.allPages === true,
      scroll: args.scroll,
      maxHeapPct: args.maxHeapPct,
    });
    if (!r.ok) {
      return toolResult(
        {
          ok: false,
          stage: r.error?.stage ?? r.stage,
          message: r.error?.message ?? r.message,
          diagnostics: r.diagnostics,
          buildLog: r.error?.buildLog ?? r.buildLog ?? null,
          problems: ctx.problems,
        },
        true,
      );
    }
    const image = readFileSync(r.pngPath).toString('base64');
    return {
      content: [
        { type: 'image', data: image, mimeType: 'image/png' },
        jsonText({
          ok: true,
          width: r.meta?.display?.width ?? ctx.display?.width,
          height: r.meta?.display?.height ?? ctx.display?.height,
          entry: ctx.entry,
          uiDir: ctx.uiDir,
          pngPath: r.pngPath,
          treePath: r.treePath,
          metaPath: r.metaPath,
          names: r.names,
          page: r.page ?? null,
          pages: r.pages ?? [],
          sheet: r.meta?.sheet ?? null,
          memory: r.meta?.memory ?? null,
          budget: r.meta?.budget ?? null,
          meta: r.meta,
          tree: r.tree,
          diagnostics: r.diagnostics,
        }),
      ],
      isError: false,
    };
  }

  if (name === 'build_ui') {
    const ctx = load(project, true, args);
    if (!ctx.ok) return errorResult('工程探测失败', { problems: ctx.problems });
    const tc = resolveToolchain(ctx);
    if (!tc.ok) return errorResult('工具链发现失败', { problems: tc.problems });
    const buildCtx = { ...ctx, toolchain: tc.toolchain };
    let script;
    try {
      ({ script } = writeBuildScript(buildCtx));
    } catch (e) {
      return errorResult(`无法生成构建脚本: ${e.message}`);
    }
    const r = buildHost(buildCtx, { quiet: true });
    return toolResult({ ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, logPath: r.logPath, script, errors: r.stderr ? [r.stderr.trim()].filter(Boolean) : [] }, !r.ok);
  }

  if (name === 'doctor') {
    const ctx = load(project, false, args);
    if (!ctx.ok) return errorResult('工程探测失败', { problems: ctx.problems });
    const tc = resolveToolchain(ctx);
    const d = runDoctor(ctx, { toolchain: tc.ok ? tc.toolchain : undefined });
    return toolResult(d, !d.ok);
  }

  if (name === 'preview_ui') {
    const ctx = load(project, true, args);
    if (!ctx.ok) return errorResult('工程探测失败', { problems: ctx.problems });
    const p = previewProject(ctx, { topmost: args.topmost === true });
    return toolResult(p, !p.ok);
  }

  return errorResult(`unknown tool: ${name}`);
}

function reply(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined;

  // JSON-RPC 2.0: notifications never receive a response. Do not run
  // request-only methods (initialize, ping, tools/list) as notifications.
  if (isNotification) {
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    return null;
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL;
      return reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          '工具名是 lvglui。界面是 C，写在 uiDir（默认 components/app_ui）里，只能 include LVGL 和 UI 自己的头；' +
          '业务数据只能通过 ui_port.h 取。画布尺寸/色深/LVGL 由工程配置决定。' +
          '改完调 render_ui 看图，再看 tree 查控件名和文字。',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      if (!params || typeof params.name !== 'string') {
        return isNotification ? null : rpcError(id, -32602, 'invalid params: tools/call requires a tool name');
      }
      const args = params.arguments ?? {};
      try {
        const out = await callTool(params.name, args);
        return reply(id, { content: out.content, isError: !!out.isError });
      } catch (e) {
        const detail = e && e.stack ? e.message : String(e);
        return reply(id, { content: [text(`internal error: ${detail}`)], isError: true });
      }
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `method not found: ${method}`);
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
    process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
    return;
  }

  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    process.stdout.write(`${JSON.stringify(rpcError(msg?.id ?? null, -32600, 'invalid request'))}\n`);
    return;
  }

  if (msg.jsonrpc !== '2.0') {
    process.stdout.write(`${JSON.stringify(rpcError(msg.id ?? null, -32600, 'invalid request: jsonrpc must be 2.0'))}\n`);
    return;
  }

  handle(msg)
    .then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    })
    .catch((e) => {
      if (msg.id !== undefined) {
        process.stdout.write(`${JSON.stringify(rpcError(msg.id, -32603, String(e?.message ?? e)))}\n`);
      }
    });
});

rl.on('close', () => process.exit(0));